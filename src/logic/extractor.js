import path from "path";
import fs from "fs-extra";
import { TaskQueue } from "cwait";
import tmp from "tmp";
import NodeGit from "nodegit";
import axios from "axios";
import { init as D2Init } from "d2";
import * as constants from "../constants";
import { buildFetchOpts } from "../utils/utils";
import log4js from "log4js";
import find from "find";
import _ from "lodash";

log4js.configure({
    appenders: {
        debug: {
            type: "file",
            filename: "debug.log",
        },
        console: { type: "console" },
    },
    categories: {
        default: {
            appenders: ["console"],
            level: "info"
        },
        debug: {
            appenders: ["debug"],
            level: "debug",
        },
    },
});
const logger = log4js.getLogger();
logger.level = "trace";

export let Extractor = function(progress) {
    this.queue = new TaskQueue(Promise, constants.CONCURRENT_QUERIES);
    this.progress = progress;
    this.currentProgress = 0;
    this.totalProgress = 0;
    this.extractionFinished = false;
    this.currentMetadataName = "";
};

Extractor.prototype.init = async function(rule) {
    this.ruleConfig = rule;
    let auth = rule.originCredentials;
    let debug = rule.debug || false;
    this.d2 = await D2Init({
        baseUrl: rule.originUrl,
        headers: {
            Authorization:
                "Basic " + Buffer.from(auth.username + ":" + auth.password).toString("base64"),
        },
    });
    this.workingDir = tmp.dirSync({ keep: debug });
    logger.info("Temporal folder: " + this.workingDir.name);

    logger.info("[GIT] Cloning " + rule.repo);
    this.repo = await NodeGit.Clone(rule.repo, this.workingDir.name, {
        fetchOpts: buildFetchOpts(rule),
        checkoutBranch: rule.repoBranch,
    });
    logger.info("[GIT] Cloned " + rule.repo);
};

Extractor.prototype.execute = async function() {
    await this.updateRepo();
};

Extractor.prototype.updateRepo = async function() {
    // Get all metadata types defined in the config and filter out undefined values
    let metadataTypes = this.ruleConfig.metadata
        .map(e => ({
            alias: e.name,
            config: e,
            model: this.d2.models[e.name],
        }))
        .filter(e => e.model !== undefined);

    // Set up the total progress
    this.totalProgress = metadataTypes.length;

    for (const type of metadataTypes) {
        if (type.config.name !== "organisationUnits") {
            const modelElements = await type.model.list({
                paging: false,
                fields: ["id", "lastUpdated"],
            });
            await this.commonSync(type, modelElements);
        } else {
            let orgUnitLevels = await this.d2.models.organisationUnitLevels.list();
            let levels = orgUnitLevels.toArray();
            for (const level of levels) {
                const modelElements = await type.model
                    .filter()
                    .on("level")
                    .equals(level.level)
                    .list({
                        paging: false,
                        fields: ["id", "lastUpdated"],
                    });
                await this.commonSync(
                    { ...type, alias: `${type.model.displayName} Level ${level.level} (${level.displayName})` },
                    modelElements
                );
            }
        }
    }

    // Update git index and commit updates
    let gitIndex = await this.repo.refreshIndex();
    await gitIndex.removeAll();
    await gitIndex.addAll();
    await gitIndex.addAll();
    await gitIndex.write();
    let oid = await gitIndex.writeTree();
    let head = await NodeGit.Reference.nameToId(this.repo, "HEAD");
    let parent = await this.repo.getCommit(head);
    let author = NodeGit.Signature.now(
        this.ruleConfig.commiter.name,
        this.ruleConfig.commiter.mail
    );
    await this.repo.createCommit(
        "HEAD",
        author,
        author,
        "Updates from remote on " + new Date().toUTCString(),
        oid,
        [parent]
    );
    let remote = await this.repo.getRemote("origin");
    logger.info("[GIT] Pushed to " + this.ruleConfig.repoBranch);
    await remote.push(
        ["HEAD:refs/heads/" + this.ruleConfig.repoBranch],
        buildFetchOpts(this.ruleConfig)
    );

    this.extractionFinished = true;
};

Extractor.prototype.commonSync = async function(type, modelElements, storeInRepository = true) {
    this.currentMetadataName = type.config.name;

    // Get local repository lastUpdated dates
    const configPath =
        this.workingDir.name + path.sep + ".updater" + path.sep + type.alias + ".json";
    fs.ensureFileSync(configPath);
    const repositoryState = fs.readJsonSync(configPath, { throws: false }) || [];

    // Query the API for server lastUpdated dates
    const serverState = modelElements.toArray().map(e => _.pick(e, ["id", "lastUpdated"]));

    // Build list of added, deleted and updated elements
    const commonElements = _.intersectionBy(serverState, repositoryState, "id");
    const addedElements = _.differenceBy(serverState, repositoryState, "id").map(e => e.id);
    const deletedElements = _.differenceBy(repositoryState, serverState, "id").map(e => e.id);
    const changedElements = _.differenceWith(commonElements, repositoryState, _.isEqual).map(
        e => e.id
    );

    // Logger messages
    logger.info("[METADATA] " + type.alias + " Common: " + commonElements.length + " elements");
    logger.info("[METADATA] " + type.alias + " Added: " + addedElements.length + " elements");
    logger.info("[METADATA] " + type.alias + " Deleted: " + deletedElements.length + " elements");
    logger.info("[METADATA] " + type.alias + " Changed: " + changedElements.length + " elements");
    logger.trace("[METADATA] " + type.alias + " Common: " + commonElements);
    logger.trace("[METADATA] " + type.alias + " Added: " + addedElements);
    logger.trace("[METADATA] " + type.alias + " Deleted: " + deletedElements);
    logger.trace("[METADATA] " + type.alias + " Changed: " + changedElements);

    // Update local repository lastUpdated dates
    fs.writeJsonSync(configPath, serverState, { spaces: 4 });

    // Query server for added elements
    await this.fetchModel(type.config, addedElements, response => {
        this.remoteServerAction("CREATE", type.config.name, response);
        if (storeInRepository)
            response[type.config.name].forEach(object => {
                this.writeToDisk(object, type);
            });
    });

    // Query server for deleted elements
    for (const deletedElement of deletedElements) {
        this.remoteServerAction("DELETE", type.config.name, deletedElement);
        if (storeInRepository) {
            const files = find.fileSync(new RegExp(deletedElement + ".json"), this.workingDir.name);
            if (files.length === 0)
                logger.error("[IO] Element " + deletedElement + " not found in disk.");
            files.forEach(file => fs.removeSync(file));
        }
    }

    // Query server for changed elements
    await this.fetchModel(type.config, changedElements, response => {
        this.remoteServerAction("UPDATE", type.config.name, response);
        if (storeInRepository)
            response[type.config.name].forEach(object => {
                this.writeToDisk(object, type);
            });
    });
};

Extractor.prototype.fetchModel = async function(config, ids, callback) {
    let promises = [];
    for (let i = 0; i < ids.length; i += 100) {
        let requestPromise = axios.get(
            this.d2.Api.getApi().baseUrl +
                "/metadata.json?fields=:owner&filter=id:in:[" +
                ids.slice(i, i + 100).toString() +
                "]",
            {
                auth: this.ruleConfig.originCredentials,
            }
        );
        requestPromise.then(response => callback(response.data));
        requestPromise.catch(error => logger.error(error));
        promises.push(requestPromise);
    }
    await Promise.all(promises);
};

Extractor.prototype.writeToDisk = function(json, type) {
    const { config } = type;

    // Set folder name
    let fileName = this.workingDir.name + path.sep;
    if (config.group) fileName += config.group + path.sep;

    if (type.alias !== type.config.name) fileName += type.alias + path.sep;
    else if (type.model.displayName) fileName += type.model.displayName + path.sep;

    // Set file name and create file
    if (json.name !== undefined) fileName += cleanName(json.name) + "-";
    if (json.id !== undefined) fileName += json.id;
    fileName += ".json";
    fs.outputJson(fileName, json, { spaces: 4 });
    return fileName;
};

function cleanName(string) {
    return string.replace(/[/\\?%*:|"<>\r\n\t]/g, "");
}

Extractor.prototype.remoteServerAction = async function(action, type, object) {};
