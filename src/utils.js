import fs from "fs";
import path from "path";
import NodeGit from "nodegit";

// List all files in a directory in Node.js recursively in a synchronous fashion
export function walkSync(dir, filelist = []) {
    let files = fs.readdirSync(dir);
    files.forEach(function (file) {
        if (fs.statSync(path.join(dir, file)).isDirectory()) {
            filelist = walkSync(path.join(dir, file), filelist);
        } else {
            filelist.push(path.join(dir, file));
        }
    });
    return filelist;
}

export function buildFetchOpts(server) {
    return {
        callbacks: {
            certificateCheck: function() { return 0; },
            credentials: function(url, userName) {
                return NodeGit.Cred.sshKeyNew(userName, server.repoCredentials.publicKey,
                    server.repoCredentials.privateKey, server.repoCredentials.passphrase);
            }
        }

    }
}