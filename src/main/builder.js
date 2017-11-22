/* globals require */

module.exports = (function () {

    'use strict';

    /**
     * @typedef {Object} fs
     * @property {function} readFileSync
     * @property {function} writeFileSync
     * @property {function} lstatSync
     * @property {function} readdirSync
     * @property {function} isDirectory
     * @property {function} appendFile
     */
    const fs = require('fs');
    /**
     * @typedef {Object} path
     * @property {function} join
     */
    const path = require('path');
    const downloadFileSync = require('download-file-sync');

    const version = require("./utils/version.js");
    const converter = require("./converter.js");
    const validator = require("./validator.js");
    const sorter = require("./sorting.js");
    const logger = require("./utils/log.js");
    const utils = require("./utils/utils.js");

    const TEMPLATE_FILE = 'template.txt';
    const FILTER_FILE = 'filter.txt';
    const REVISION_FILE = 'revision.json';
    const METADATA_FILE = 'metadata.json';
    const EXCLUDE_FILE = 'exclude.txt';

    let currentDir;

    /**
     * Sync reads file content
     *
     * @param path
     * @returns {*}
     */
    const readFile = function (path) {
        try {
            return fs.readFileSync(path, {encoding: 'utf-8'});
        } catch (e) {
            return null;
        }
    };

    /**
     * Sync writes content to file
     *
     * @param path
     * @param data
     */
    const writeFile = function (path, data) {
        fs.writeFileSync(path, data, 'utf8');
    };

    /**
     * Sync downloads file from url
     *
     * @param url
     */
    const downloadFile = function (url) {
        logger.log(`Downloading: ${url}`);

        return downloadFileSync(url);
    };

    /**
     * Splits lines
     *
     * @param string
     */
    const splitLines = function (string) {
        return string.split(/[\r\n]+/);
    };

    /**
     * Removes comments from lines
     *
     * @param lines
     */
    const stripComments = function (lines) {
        logger.log('Stripping comments..');

        return lines.filter((line) => !line.startsWith('!'));
    };

    /**
     * Checks if line is excluded with specified set of exclusions
     *
     * @param line
     * @param exclusions
     * @returns {boolean}
     */
    const isExcluded = function (line, exclusions) {
        for (let exclusion of exclusions) {
            exclusion = exclusion.trim();

            if (!exclusion.startsWith('!')) {
                if (exclusion.startsWith("/") && exclusion.endsWith("/")) {
                    if (line.match(new RegExp(exclusion.substring(1, exclusion.length - 2)))) {
                        return true;
                    }
                } else {
                    if (line.includes(exclusion)) {
                        return true;
                    }
                }
            }
        }

        return false;
    };

    /**
     * Applies exclusion from exclusions file
     *
     * @param lines
     * @param exclusionsFileName
     * @returns {*}
     */
    const exclude = function (lines, exclusionsFileName) {

        logger.log('Applying exclusions..');

        const exclusionsFile = path.join(currentDir, exclusionsFileName);
        let exclusions = readFile(exclusionsFile);
        if (!exclusions) {
            return lines;
        }

        exclusions = splitLines(exclusions);

        const result = lines.filter((line) => !isExcluded(line, exclusions));

        logger.log(`Excluded lines: ${lines.length - result.length}`);

        return result;
    };

    /**
     * Strips leading and trailing quotes from string
     *
     * @param s
     * @returns {*}
     */
    const stripEndQuotes = function (s) {
        let t = s.length;
        if (s.charAt(0) === '"') {
            s = s.substring(1, t--);
        }
        if (s.charAt(--t) === '"') {
            s = s.substring(0, t);
        }
        return s;
    };

    /**
     * Parses include line
     *
     * @param line
     * @returns {{url: string, stripComments: boolean, exclude: *}}
     */
    const parseIncludeLine = function (line) {
        const parts = line.split(' ');

        let url = parts[1].trim();

        url = stripEndQuotes(url);

        let stripComments = false;
        let exclude = null;

        for (let i = 1; i < parts.length; i++) {
            let attribute = parts[i].trim();
            if (attribute.startsWith("/stripComments")) {
                stripComments = true;
            } else if (attribute.startsWith("/exclude=")) {
                exclude = attribute.substring(attribute.indexOf('=') + 1);
                exclude = stripEndQuotes(exclude);
            }
        }

        return {
            url: url,
            stripComments: stripComments,
            exclude: exclude
        };
    };

    /**
     * Creates content from include line
     *
     * @param line
     * @returns {Array}
     */
    const include = function (line) {
        let result = [];

        const options = parseIncludeLine(line);

        if (!options.url) {
            logger.warn('Invalid include url');
            return result;
        }

        logger.log(`Applying inclusion from: ${options.url}`);

        const included = options.url.includes(':') ?
            downloadFile(options.url) :
            readFile(path.join(currentDir, options.url));

        if (included) {
            result = splitLines(included);

            if (options.exclude) {
                result = exclude(result, options.exclude);
            }

            if (options.stripComments) {
                result = stripComments(result);
            }
        }

        result = converter.convert(result);

        logger.log(`Inclusion lines: ${result.length}`);

        return result;
    };

    /**
     * Compiles filter lines
     *
     * @param template
     * @returns {Array}
     */
    const compile = function (template) {
        let result = [];

        const lines = splitLines(template);
        for (let line of lines) {
            if (line.startsWith('@include ')) {
                const inc = include(line.trim());

                let k = 0;
                while (k < inc.length) {
                    result.push(inc[k].trim());
                    k++;
                }
            } else {
                result.push(line.trim());
            }
        }

        result = exclude(result, EXCLUDE_FILE);
        result = utils.removeDuplicates(result);

        result = validator.validate(result);
        result = validator.blacklistDomains(result);
        result = sorter.sort(result);

        return result;
    };

    /**
     * Creates revision object
     *
     * @param path
     * @returns {{version: string, timeUpdated: number}}
     */
    const makeRevision = function (path) {
        const result = {
            "version": "1.0.0.0",
            "timeUpdated": new Date().getTime()
        };

        const current = readFile(path);
        if (current) {
            let p = JSON.parse(current);
            if (p && p.version) {
                result.version = version.increment(p.version);
            }
        }

        return result;
    };

    /**
     * Creates header contents
     *
     * @param metadataFile
     * @param revision
     * @returns {[*,*,*,*,string]}
     */
    const makeHeader = function (metadataFile, revision) {
        logger.log('Adding header..');

        const metadataString = readFile(metadataFile);
        if (!metadataString) {
            throw new Error('Error reading metadata');
        }

        const metadata = JSON.parse(metadataString);

        return [
            `! Title: ${metadata.name}`,
            `! Description: ${metadata.description}`,
            `! Version: ${revision.version}`,
            `! TimeUpdated: ${new Date(revision.timeUpdated).toDateString()}`,
            `! Expires: ${metadata.expires} (update frequency)`
        ];
    };

    /**
     * Builds filter txt file from directory contents
     *
     * @param filterDir
     */
    const buildFilter = function (filterDir) {
        currentDir = filterDir;

        const template = readFile(path.join(currentDir, TEMPLATE_FILE));
        if (!template) {
            throw new Error('Invalid template');
        }

        const revisionFile = path.join(currentDir, REVISION_FILE);
        const revision = makeRevision(revisionFile);

        logger.log('Compiling..');
        const compiled = compile(template);
        logger.log('Compiled length:' + compiled.length);

        const metadataFile = path.join(currentDir, METADATA_FILE);
        const header = makeHeader(metadataFile, revision);

        const filter = header.concat(compiled);

        logger.log('Writing filter file, lines:' + filter.length);
        writeFile(path.join(currentDir, FILTER_FILE), filter.join('\r\n'));
        logger.log('Writing revision file..');
        writeFile(revisionFile, JSON.stringify(revision, null, "\t"));
    };

    /**
     * Builds all filters in child directories
     *
     * @param filtersDir
     * @param logFile
     * @param domainBlacklistFile
     */
    const build = function (filtersDir, logFile, domainBlacklistFile) {
        logger.initialize(logFile);
        validator.init(domainBlacklistFile);

        const items = fs.readdirSync(filtersDir);

        for (let directory of items) {
            const filterDir = path.join(filtersDir, directory);
            if (fs.lstatSync(filterDir).isDirectory()) {

                logger.log(`Building filter: ${directory}`);
                buildFilter(filterDir);
                logger.log(`Building filter: ${directory} ok`);
            }
        }
    };

    return {
        build: build
    };
})();
