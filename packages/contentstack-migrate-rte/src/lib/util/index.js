const contentstacksdk = require('@contentstack/management')
const {Command} = require('@contentstack/cli-command')
const command = new Command()
const {cli} = require('cli-ux')
const chalk = require('chalk')
const {isEmpty, find, get, isArray, isUndefined, set, flatten, cloneDeep} = require('lodash')
const Validator = require('jsonschema').Validator
const configSchema = require('./config_schema.json')
const {JSDOM} = require('jsdom')
const collapseWithSpace = require('collapse-whitespace')
const {v4} = require('uuid')
const {htmlToJson} = require('@contentstack/json-rte-serializer')
const path = require('path')

function formatHostname(hostname) {
  return hostname.split('//').pop()
}
function getStack(data) {
  const tokenDetails = data.token
  const client = contentstacksdk.client({
    host: formatHostname(data.host),
  })
  const stack = client.stack({api_key: tokenDetails.apiKey, management_token: tokenDetails.token})

  stack.host = data.host
  return stack
}
async function getConfig(flags) {
  try {
    let config
    if (flags.configPath) {
      config = require(path.resolve(flags.configPath))
    } else {
      config = {
        alias: flags.alias,
        content_type: flags.content_type,
        isGlobalField: flags.isGlobalField,
        paths: [
          {
            from: flags.htmlPath,
            to: flags.jsonPath,
          },
        ],
        delay: flags.delay,
      }
    }
    if (checkConfig(config)) {
      let confirmed = await confirmConfig(config, flags.yes)
      if (confirmed) {
        return config
      }
      throw new Error('User aborted the command.')
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND') {
      throw new Error('The specified path to config file does not exist.')
    }
    if (error.schema && error.errors && error.errors[0]) {
      throwConfigError(error.errors[0])
    }
    throw error
  }
}
function getToken(alias) {
  try {
    return command.getToken(alias)
  } catch (error) {
    throw new Error('Invalid alias provided for the management token.')
  }
}
function getContentType(stack, contentTypeUid) {
  return stack.contentType(contentTypeUid).fetch({include_global_field_schema: true})
  .then(content => content)
  .catch(error => {
    throw new Error(error.errorMessage || error.message)
  })
}
function getGlobalField(stack, globalFieldUid) {
  return stack.globalField(globalFieldUid).fetch({include_content_types: true})
  .then(content => content)
  .catch(error => {
    throw new Error(error.errorMessage || error.message)
  })
}
function throwConfigError(error) {
  // console.log(error)
  const {name, path, message, argument} = error
  let fieldName = path.join('.')
  if (fieldName === '') {
    fieldName = 'Config'
  }
  if (name === 'required') {
    throw new Error(`${fieldName} is mandatory while defining config.`)
  } else if (name === 'type') {
    throw new Error(`Invalid key type. ${fieldName} must be of ${argument[0] || 'string'} type(s).`)
  }
}
function checkConfig(config) {
  let v = new Validator()
  let res = v.validate(config, configSchema, {throwFirst: true})
  return res.valid
}
function prettyPrint(data) {
  console.log(chalk.yellow('Configuration to be used for executing this command:'))
  console.log(chalk.grey(JSON.stringify(data, null, 2)))
  console.log('\n')
}
async function confirmConfig(config, skipConfirmation) {
  if (skipConfirmation) {
    return true
  }
  prettyPrint(config)
  let confirmation = await cli.confirm('Do you want to continue with this configuration ? [yes or no]')
  return confirmation
}
const delay = ms => new Promise(res => setTimeout(res, ms))
async function updateEntriesInBatch(contentType, config, skip = 0) {
  let entryQuery = {
    include_count: true,
    skip: skip,
    limit: 100,
  }
  await contentType.entry().query(entryQuery).find().then(async entriesResponse => {
    skip += entriesResponse.items.length
    let entries = entriesResponse.items

    for (const entry of entries) {
      // console.log("entry", entry)
      await updateSingleEntry(entry, contentType, config)
      await delay(config.delay || 1000)
    }
    if (skip === entriesResponse.count) {
      // console.log("exit")
      return Promise.resolve()
    }
    await updateEntriesInBatch(contentType, config, skip)
  }).catch(error => {
    throw new Error(error.message)
  })
}
async function updateSingleContentTypeEntries(stack, contentTypeUid, config) {
  let contentType = await getContentType(stack, contentTypeUid)
  let schema = contentType.schema
  for (const path of config.paths) {
    if (!isEmpty(schema)) {
      isPathValid(contentType.schema, path)
    } else {
      throw new Error(`The ${contentTypeUid} content type contains an empty schema.`)
    }
  }
  await updateEntriesInBatch(contentType, config)
  config.contentTypeCount += 1
}
async function updateSingleContentTypeEntriesWithGlobalField(contentType, config) {
  let schema = contentType.schema
  for (const path of config.paths) {
    isPathValid(schema, path)
  }
  await updateEntriesInBatch(contentType, config)
  config.contentTypeCount += 1
}
async function updateSingleEntry(entry, contentType, config) {
  let schema = contentType.schema
  let paths = config.paths
  // console.log("before entry update", entry)

  for (const path of paths) {
    let htmlPath = path.from.split('.')
    let jsonPath = path.to.split('.')
    let htmlRteUid = htmlPath[htmlPath.length - 1]
    let jsonRteUid = jsonPath[jsonPath.length - 1]
    let parentPath = htmlPath.slice(0, htmlPath.length - 1).join('.')
    setEntryData(parentPath, entry, schema, {htmlRteUid, jsonRteUid})
  }
  try {
    await entry.update()
    config.entriesCount += 1
  } catch (error) {
    config.errorEntriesUid.push(entry.uid)
    console.log(chalk.red(`Error while updating '${entry.uid}' entry`))
    if (error.errors) {
      const errVal = Object.entries(error.errors)
      errVal.forEach(([key, vals]) => {
        console.log(chalk.red(` ${key}:-  ${vals.join(',')}`))
      })
    }
  }

  // console.log("updated entry", entry)
}
function traverseSchemaForField(schema, path, field_uid) {
  let paths = path.split('.')
  if (paths.length === 1) {
    let field = find(schema, o => {
      return o.uid === paths[0]
    })
    if (Boolean(field) && field.uid === field_uid) {
      return field
    }
  } else {
    let fieldUid = paths.shift()
    let fieldSchema = find(schema, {uid: fieldUid})
    if (!isEmpty(fieldSchema)) {
      if (fieldSchema.data_type === 'group' || fieldSchema.data_type === 'global_field') {
        return traverseSchemaForField(fieldSchema.schema, paths.join('.'), field_uid)
      }
      if (fieldSchema.data_type === 'blocks') {
        let blockUid = paths.shift()
        let block = find(fieldSchema.blocks, {uid: blockUid})
        if (!isEmpty(block) && block.schema) {
          return traverseSchemaForField(block.schema, paths.join('.'), field_uid)
        }
      }
    }
  }
  return {}
}
function isPathValid(schema, path) {
  // console.log("path", path)
  let pathFrom = path.from.split('.')
  let htmlParentPath = pathFrom.slice(0, pathFrom.length - 1).join('.')
  const rteUid = pathFrom[pathFrom.length - 1]
  let rteSchema = traverseSchemaForField(schema, path.from, rteUid)
  if (isEmpty(rteSchema)) {
    throw new Error(`The specified path to ${rteUid} HTML RTE does not exist.`)
  }
  let ishtmlRteMultiple = rteSchema.multiple || false
  if (rteSchema.field_metadata && rteSchema.field_metadata.allow_rich_text) {
    let pathTo = path.to.split('.')
    let jsonParentPath = pathTo.slice(0, pathTo.length - 1).join('.')

    const jsonUid = pathTo[pathTo.length - 1]
    let jsonSchema = traverseSchemaForField(schema, path.to, jsonUid)
    if (isEmpty(jsonSchema)) {
      throw new Error(`The specified path to ${jsonUid} JSON RTE does not exist.`)
    }
    let isJSONRteMultiple = jsonSchema.multiple || false

    if (jsonSchema.field_metadata && jsonSchema.field_metadata.allow_json_rte) {
      if (htmlParentPath === jsonParentPath) {
        if (ishtmlRteMultiple === isJSONRteMultiple) {
          return true
        }
        throw new Error(`Cannot convert "${ishtmlRteMultiple ? 'Multiple' : 'Single'}" type HTML RTE to "${isJSONRteMultiple ? 'Multiple' : 'Single'}" type JSON RTE.`)
      } else {
        throw new Error('To complete migration, HTML RTE and JSON RTE should be present at the same field depth level.')
      }
    } else {
      throw new Error(`The specified path to ${jsonUid} JSON RTE does not exist.`)
    }
  } else {
    throw new Error(`The specified path to ${rteUid} HTML RTE does not exist.`)
  }
}
function setEntryData(path, entry, schema, fieldMetaData) {
  let paths = path.split('.')
  if (paths.length === 1 && paths[0] === '') {
    paths.shift()
  }
  if (paths.length > 0) {
    let field = find(schema, {
      uid: paths[0],
    })
    if (field) {
      if (field.data_type === 'group' || field.data_type === 'global_field') {
        paths.shift()
        // console.log("paths", paths)

        let sub_entry_data = get(entry, field.uid)
        // console.log("sub_Entry",sub_entry_data)
        if (isArray(sub_entry_data)) {
          for (const sub_data of sub_entry_data) {
            setEntryData(paths.join('.'), sub_data, field.schema, fieldMetaData)
          }
        } else {
          setEntryData(paths.join('.'), sub_entry_data, field.schema, fieldMetaData)
        }
      } else if (field.data_type === 'blocks') {
        if (field.blocks) {
          let ModularBlockUid = paths.shift()
          let blockUid = paths.shift()
          let blockField = find(field.blocks, {uid: blockUid})
          // console.log("blockUid",blockUid)
          if (blockField) {
            let modularBlockDetails = get(entry, ModularBlockUid) || []
            // console.log("modularBlockDetails",modularBlockDetails)
            for (const blocks of modularBlockDetails) {
              let blockdata = get(blocks, blockUid)
              // console.log("blockData",blockdata)
              if (blockdata) {
                setEntryData(paths.join('.'), blockdata, blockField.schema, fieldMetaData)
              }
            }
          }
        }
      }
    }
  } else if (paths.length === 0) {
    if (entry) {
      const {htmlRteUid, jsonRteUid} = fieldMetaData
      const htmlValue = get(entry, htmlRteUid)
      // check if html field exist in traversed path
      if (!isUndefined(htmlValue)) {
        // if Rte field is multiple
        if (isArray(htmlValue)) {
          for (let i = 0; i < htmlValue.length; i++) {
            let html = htmlValue[i]
            setJsonValue(html, entry, `${jsonRteUid}.${i}`)
          }
        } else {
          setJsonValue(htmlValue, entry, jsonRteUid)
        }
      }
    }
  }
}

function setJsonValue(html, entry, path) {
  let doc = convertHtmlToJson(html)
  set(entry, path, doc)
}
function convertHtmlToJson(html) {
  const dom = new JSDOM(html)
  let htmlDoc = dom.window.document.querySelector('body')
  collapseWithSpace(htmlDoc)
  let doc
  try {
    doc = htmlToJson(htmlDoc)
    applyDirtyAttributesToBlock(doc)
  } catch (error) {
    // console.log("err", err)
    throw new Error('Error while converting html '.concat(error.message))
  }
  return doc
}
function applyDirtyAttributesToBlock(block) {
  if (block.hasOwnProperty('text')) {
    return block
  }
  let children = flatten([...block.children || []].map(applyDirtyAttributesToBlock))
  if (block.hasOwnProperty('type')) {
    set(block, 'attrs.dirty', true)
  }
  block.children = children
  return block
}
async function updateContentTypeForGlobalField(stack, global_field, config) {
  const globalField = await getGlobalField(stack, global_field)
  if (isEmpty(globalField.schema)) {
    throw new Error(`The ${global_field} Global field contains an empty schema.`)
  }
  let allReferredContentTypes = globalField.referred_content_types
  if (!isEmpty(allReferredContentTypes)) {
    for (const contentType of allReferredContentTypes) {
      let contentTypeInstance = await getContentType(stack, contentType.uid)
      const schema = contentTypeInstance.schema
      if (!isEmpty(schema) && !isUndefined(schema)) {
        let globalFieldPaths = getGlobalFieldPath(contentTypeInstance.schema, global_field)
        let newConfig = cloneDeep(config)
        updateMigrationPath(globalFieldPaths, newConfig)
        await updateSingleContentTypeEntriesWithGlobalField(contentTypeInstance, newConfig)
        config.contentTypeCount = newConfig.contentTypeCount
        config.entriesCount = newConfig.entriesCount
        config.errorEntriesUid = newConfig.errorEntriesUid
      } else {
        throw new Error(`The ${contentType.uid} content type referred in ${globalField.uid} contains an empty schema.`)
      }
    }
  } else {
    throw new Error(`${globalField.uid} Global field is not referred in any content type.`)
  }
  // console.log("globolfield", globalField)
}
function updateMigrationPath(globalFieldPaths, config) {
  const newPath = []
  for (const path of config.paths) {
    // console.log("path", path)
    for (const globalFieldPath of globalFieldPaths) {
      newPath.push({from: globalFieldPath + '.' + path.from, to: globalFieldPath + '.' + path.to})
    }
  }
  config.paths = newPath
}
function getGlobalFieldPath(schema, globalFieldUid) {
  let paths = []

  function genPath(prefix, path) {
    return isEmpty(prefix) ? path : [prefix, path].join('.')
  }

  function traverse(fields, path) {
    path = path || ''
    for (const field of fields) {
      let currPath = genPath(path, field.uid)
      if (field.data_type === 'group') {
        traverse(field.schema, currPath)
      }

      if (
        field.data_type === 'global_field' &&
        isUndefined(field.schema) === false &&
        isEmpty(field.schema) === false
      ) {
        if (field.reference_to === globalFieldUid) {
          paths.push(currPath)
        }
      }
      if (field.data_type === 'blocks') {
        field.blocks.forEach(function (block) {
          if (block.schema) {
            if (block.reference_to && block.reference_to === globalFieldUid) {
              paths.push(currPath + '.' + block.uid)
            }
            traverse(block.schema, currPath + '.' + block.uid)
          }
        })
      }
      // experience_container
      if (field.data_type === 'experience_container') {
        if (field.variations) {
          field.variations.forEach(function (variation) {
            if (variation.schema)
              traverse(variation.schema, currPath + '.' + variation.uid)
          })
        }
      }
    }
  }

  if (!isEmpty(schema)) {
    traverse(schema, '')
  }

  return paths
}
module.exports = {
  getStack,
  getConfig,
  getToken,
  getContentType,
  updateEntriesInBatch,
  updateSingleContentTypeEntries,
  updateContentTypeForGlobalField,
  command,
}
