/*!
 * Contentstack Import
 * Copyright (c) 2019 Contentstack LLC
 * MIT Licensed
 */

let ncp = require('ncp')
let fs = require('fs-extra')
let path = require('path')
const chalk = require('chalk')
let _ = require('lodash')

let login = require('./lib/util/login')
let util = require('./lib/util')

let {addlogs} = require('./lib/util/log')

exports.initial = function (configData) {
  return new Promise(function (resolve, reject) {
    let config = util.initialization(configData)
    config.oldPath = config.data
    if (config && config !== undefined) {
      login(config)
      .then(async function () {
        const foldeExists = await fs.pathExists(config.data)
        if (foldeExists) {
          let migrationBackupDirPath = path.join(process.cwd(), '_backup_/' + util.folderPath() + Math.floor((Math.random() * 1000)))
          return createBackup(migrationBackupDirPath, config).then(basePath => {
            config.data = basePath
            return util.sanitizeStack(config)
          }).catch(e => {
            console.error(e)
            process.exit(1)
          })
          .then(() => {
            let types = config.modules.types
            if (config.moduleName && config.moduleName !== undefined) {
              singleImport(config.moduleName, types, config).then(() => {
                return removeBackupDir(migrationBackupDirPath, config.cleanUp)
              }).then(() => {
                return resolve()
              })
            } else {
              allImport(config, types).then(() => {
                return removeBackupDir(migrationBackupDirPath, config.cleanUp)
              }).then(() => {
                return resolve()
              })
            }
          }).catch(e => {
            console.error(e)
            return reject(e)
          })
        }
        let filename = path.basename(config.data)
        addlogs(config, chalk.red(filename + ' Folder does not Exist'), 'error')
      }).catch(error => {

      })
    }
  })
}

let singleImport = async (moduleName, types, config) => {
  return new Promise(async (resolve, reject) => {
    if (types.indexOf(moduleName) > -1) {
      if (!config.master_locale) {
        try {
          var masterLocalResponse = await util.masterLocalDetails(config)
          let master_locale = {code: masterLocalResponse.code}
          config.master_locale = master_locale
        } catch (error) {
          console.log('Error to fetch the stack details' + error)
        }
      }
      let exportedModule = require('./lib/import/' + moduleName)
      exportedModule.start(config).then(async function () {
        if (moduleName === 'content-types') {
          let ctPath = path.resolve(config.data, config.modules.content_types.dirName)
          let fieldPath = path.join(ctPath + '/field_rules_uid.json')
          if (fieldPath && fieldPath !== undefined) {
            await util.field_rules_update(config, ctPath)
          }
        }
        addlogs(config, moduleName + ' imported successfully!', 'success')
        addlogs(config, 'The log for this is stored at ' + path.join(config.oldPath, 'logs', 'import'), 'success')
        return resolve()
      }).catch(function (error) {
        addlogs(config, 'Failed to migrate ' + moduleName, 'error')
        addlogs(config, error, 'error')
        addlogs(config, 'The log for this is stored at ' + path.join(config.oldPath, 'logs', 'import'), 'error')
        return reject()
      })
    } else {
      addlogs(config, 'Please provide valid module name.', 'error')
      return reject()
    }
  })
}

let allImport = async (config, types) => {
  return new Promise(async (resolve, reject) => {
    try {
      for (let i = 0; i < types.length; i++) {
        let type = types[i]
        var exportedModule = require('./lib/import/' + type)
        if (i === 0 && !config.master_locale) {
          var masterLocalResponse = await util.masterLocalDetails(config)
          let master_locale = {code: masterLocalResponse.code}
          config.master_locale = master_locale
        }
        await exportedModule.start(config).then(result => {

        })
      }
      if (config.target_stack && config.source_stack) {
        addlogs(config, chalk.green('The data of the ' + config.sourceStackName + ' stack has been imported into ' + config.destinationStackName + ' stack successfully!'), 'success')
        addlogs(config, 'The log for this is stored at ' + path.join(config.data, 'logs', 'import'), 'success')
      } else {
        addlogs(config, chalk.green('Stack: ' + config.target_stack + ' has been imported succesfully!'), 'success')
        addlogs(config, 'The log for this is stored at ' + path.join(config.oldPath, 'logs', 'import'), 'success')
      }
      return resolve()
    } catch (error) {
      addlogs(config, chalk.red('Failed to migrate stack: ' + config.target_stack + '. Please check error logs for more info'), 'error')
      addlogs(config, error, 'error')
      addlogs(config, 'The log for this is stored at ' + path.join(config.oldPath, 'logs', 'import'), 'error')
      return reject()
    }
  })
}

async function createBackup(backupDirPath, config) {
  const dirExists = await fs.pathExists(config.backupDirPath)
  return new Promise(async (resolve, reject) => {
    if (config.hasOwnProperty('useBackedupDir') && dirExists) {
      return resolve(config.useBackedupDir)
    }
    await fs.ensureDir(backupDirPath)
    ncp.limit = config.backupConcurrency || 16
    if (path.isAbsolute(config.data)) {
      return ncp(config.data, backupDirPath, error => {
        if (error) {
          return reject(error)
        }
        return resolve(backupDirPath)
      })
    }
    ncp(config.data, backupDirPath, error => {
      if (error) {
        return reject(error)
      }
      return resolve(backupDirPath)
    })
  })
}

function  removeBackupDir(backupDirPath, cleanUp) {
  if (!cleanUp) {
    return
  }
  return fs.remove(backupDirPath)
}
