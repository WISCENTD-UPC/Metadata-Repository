import fs from "fs-extra";
import vorpal from "vorpal";
import ProgressBar from "progress";

import {Extractor} from "./src/extractor";

let app = vorpal();

app.command('update <rule>', 'Build and update a given rule', null)
    .action(async function (args, callback) {
        let bar = newProgressBar();

        fs.ensureFileSync('./config.json');
        let config = fs.readJsonSync('./config.json');
        let rule = config.rules.find(e => e.name === args.rule);
        if (rule !== undefined) {
            let extractor = new Extractor(bar);
            await extractor.init(rule);
            await extractor.execute();
        } else console.error("Rule " + args.rule + " not found in config.json");
        callback();
    });

app.parse(process.argv);

function newProgressBar() {
    return new ProgressBar('Fetching [:bar] :percent :name', {
        width: 40,
        total: 100
    });
}