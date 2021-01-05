/* eslint-disable no-console */
/*!
 * Contentstack Import
 * Copyright (c) 2019 Contentstack LLC
 * MIT Licensed
 */
let mkdirp = require('mkdirp')
let fs = require('fs')
let path = require('path')
let _ = require('lodash')
let chalk = require('chalk')

let helper = require('../util/fs')
let util = require('../util')
let { addlogs } = require('../util/log')
let supress = require('../util/extensionsUidReplace')
let stack = require('../util/contentstack-management-sdk')

let config = require('../../config/default')
let reqConcurrency = config.concurrency
let contentTypeConfig = config.modules.content_types
let globalFieldConfig = config.modules.globalfields
let globalfieldsFolderPath
let contentTypesFolderPath
let mapperFolderPath
let globalFieldMapperFolderpath
let globalFieldUpdateFile
let globalFieldPendingpath
let skipFiles = ['__master.json', '__priority.json', 'schema.json']
let fileNames
let field_rules_ct = []
let client

function importContentTypes() {
  this.contentTypes = []
  this.schemaTemplate = require('../util/schemaTemplate')
  this.requestOptions = {
    json: {},
  }
}

importContentTypes.prototype = {
  start: async function (credentialConfig) {
    addlogs(config, 'Migrating contenttypes', 'success')
    let self = this
    config = credentialConfig
    client = stack.Client(config)
    globalfieldsFolderPath = path.resolve(config.data, globalFieldConfig.dirName)
    contentTypesFolderPath = path.resolve(config.data, contentTypeConfig.dirName)
    mapperFolderPath = path.join(config.data, 'mapper', 'content_types')
    globalFieldMapperFolderpath = helper.readFile(path.join(config.data, 'mapper', 'global_fields', 'success.json'))
    globalFieldUpdateFile = path.join(config.data, 'mapper', 'global_fields', 'success.json')
    globalFieldPendingpath =  helper.readFile(path.join(config.data, 'mapper', 'global_fields', 'pending_global_fields.js'))
    fileNames = fs.readdirSync(path.join(contentTypesFolderPath))
    self.globalfields = helper.readFile(path.resolve(globalfieldsFolderPath, globalFieldConfig.fileName))
    for (let index in fileNames) {
      if (skipFiles.indexOf(fileNames[index]) === -1) {
        self.contentTypes.push(helper.readFile(path.join(contentTypesFolderPath, fileNames[index])))
      }
    }

    self.contentTypeUids = _.map(self.contentTypes, 'uid')
    self.createdContentTypeUids = []
    if (!fs.existsSync(mapperFolderPath)) {
      mkdirp.sync(mapperFolderPath)
    }
    // avoid re-creating content types that already exists in the stack
    if (fs.existsSync(path.join(mapperFolderPath, 'success.json'))) {
      self.createdContentTypeUids = helper.readFile(path.join(mapperFolderPath, 'success.json')) || []
    }
    self.contentTypeUids = _.difference(self.contentTypeUids, self.createdContentTypeUids)
    // remove contet types, already created
    _.remove(this.contentTypes, function (contentType) {
      return self.contentTypeUids.indexOf(contentType.uid) === -1
    })
    return new Promise(async function (resolve, reject) {
      // return Promise.map(self.contentTypeUids, function (contentTypeUid) {
      for (let contentTypeUid in self.contentTypeUids) {
        await self.seedContentTypes(self.contentTypeUids[contentTypeUid]).then(function () {

        }).catch(function (error) {
          return reject(error)
        })
      }

      await self.batchLimit().then(function () {
        addlogs(config, chalk.green('Content types have been imported successfully!'), 'success')
        return resolve()
      }).catch(function (err) {
        return reject()
      })
    })
  },
  seedContentTypes: function (uid) {
    let self = this
    return new Promise(function (resolve, reject) {
      let body = _.cloneDeep(self.schemaTemplate)
      body.content_type.uid = uid
      body.content_type.title = uid
      let requestObject = _.cloneDeep(self.requestOptions)
      requestObject.json = body
      return client.stack({ api_key: config.target_stack, management_token: config.management_token }).contentType().create(requestObject.json)
        .then(result => {
          return resolve()
        })
        .catch(function (error) {
          if (error.error_code === 115 && (error.errors.uid || error.errors.title)) {
            // content type uid already exists
            return resolve()
          }
          return reject(error)
        })
    })
  },
  updateContentTypes: function (contentType) {
    let self = this
    return new Promise(function (resolve, reject) {
      let requestObject = _.cloneDeep(self.requestOptions)
      if (contentType.field_rules) {
        field_rules_ct.push(contentType.uid)
        delete contentType.field_rules
      }
      supress(contentType.schema)
      requestObject.json.content_type = contentType
      client.stack({ api_key: config.target_stack, management_token: config.management_token }).contentType(contentType.uid).fetch()
        .then(contentTypeResponse => {
          Object.assign(contentTypeResponse, _.cloneDeep(contentType))
          contentTypeResponse.update()
        })
        .then(UpdatedcontentType => {
          return resolve()
        }).catch(err => {
          let error = JSON.parse(err.message)
          addlogs(config, error, 'error')
          return reject()
        })
    })
  },

  updateGlobalfields: function () {
    let self = this
    return new Promise(async function (resolve, reject) {
      // eslint-disable-next-line no-undef
      for (let i = 0; i < globalFieldPendingpath.length; i++) {
        let lenGlobalField = (self.globalfields).length
        let globalfield = globalFieldPendingpath[i]
        let Obj = _.find(self.globalfields, { 'uid': globalfield });
        await client.stack({ api_key: config.target_stack, management_token: config.management_token }).globalField(globalfield).fetch()
          .then(globalFieldResponse => {
            globalFieldResponse.schema = Obj.schema
            globalFieldResponse.update()
            let updateObjpos = _.findIndex(globalFieldMapperFolderpath, function (successobj) {
              let global_field_uid = globalFieldResponse.uid
              return global_field_uid === successobj
            })
            globalFieldMapperFolderpath.splice(updateObjpos, 1, Obj)
            helper.writeFile(globalFieldUpdateFile, globalFieldMapperFolderpath)
          }).catch(function (err) {
            let error = JSON.parse(err.message)
            // eslint-disable-next-line no-console
            addlogs(config, chalk.red('Globalfield failed to update ' + JSON.stringify(error.errors)), 'error')
          })
      }
      return resolve()
    })
  },

  batchLimit: async function () {
    let self = this
    return new Promise(async function (resolve, reject) {
      let batches = []
      let lenObj = self.contentTypes
      for (let i = 0; i < lenObj.length; i += 7) {
        batches.push(lenObj.slice(i, i + 7))
      }

      for (let i = 0; i < batches.length; i++) {
        let batch = batches[i]
        for (let j = 0; j < batch.length; j++) {
          let contentType = batch[j]
          await self.updateContentTypes(contentType).then(function () {
            addlogs(config, contentType.uid + ' was updated successfully!', 'success')
            return
          }).catch(function (err) {
            return reject()
          })
        }
      }
      if (field_rules_ct.length > 0) {
        fs.writeFile(contentTypesFolderPath + '/field_rules_uid.json', JSON.stringify(field_rules_ct), function (err) {
          if (err) throw err
        })
      }

      if( globalFieldPendingpath.length !== 0 ) {
        await self.updateGlobalfields().then(function () {
          return resolve()
        }).catch(err => {
          return reject(err)
        })
      } else {
        return resolve()
      }
    }).catch(error => {
      return reject(error)
    })
  }
}

module.exports = new importContentTypes()