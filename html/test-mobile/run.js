// Runs the mobile test groups against a built page: node run.js <page.html> [group ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const groups = { ...require('./groups-input'), ...require('./groups-view'), ...require('./groups-life') };

async function main() {
    const page = path.resolve(process.argv[2]);
    const names = process.argv.slice(3);
    const wanted = names.length ? names : Object.keys(groups);
    const out = process.env.MOBILE_RESULTS || path.join(lib.SCRATCH, 'results.tsv');
    const results = new lib.Results(out);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mterm-'));
    const browser = await lib.launch();
    let port = Number(process.env.MOBILE_PORT || 17710);
    try {
        for (const name of wanted) {
            lib.tmuxKill();
            try {
                await groups[name]({ page, browser, results, tmp, port: port++, group: name });
            } catch (e) {
                results.add(name, 'group crashed', false, String(e.stack || e).split('\n').slice(0, 4).join(' | ').slice(0, 400));
            }
            await lib.cleanup();
        }
    } finally {
        await browser.close().catch(() => {});
        await lib.cleanup();
        lib.tmuxKill();
    }
    console.log(results.summary());
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
