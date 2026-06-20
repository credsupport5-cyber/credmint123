// One-time REVERT of backfillWallets.ts.
// Restores each wallet to its PRE-backfill (old/left) values from the captured
// apply-run log. Only the 79 wallets the backfill changed are listed here.
//
// Run:
//   npx ts-node prisma/revertWallets.ts --dry-run   # preview, no write
//   npx ts-node prisma/revertWallets.ts             # apply revert
//
// Safety: a wallet is reverted ONLY if its current DB values still equal the
// backfilled NEW values. If a user earned/spent since the backfill (current !=
// new), that row is SKIPPED with a warning — we never clobber fresh balances.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

// Verbatim apply-run log. Format per row:
//   <phone>: bal OLD->NEW  avail OLD->NEW  wd OLD->NEW  lock OLD->NEW
const LOG = `
9999999999: bal 1025->825  avail 1025->0  wd 0->825  lock 0->0
0000000000: bal 5425->8080  avail 4425->1500  wd 0->3080  lock 1670->3500
7696900709: bal 97226->99576  avail 97226->88095  wd 0->7981  lock 1325->3500
8979426929: bal 11247->28395  avail 11247->0  wd 0->11397  lock 3999->16998
9466374474: bal 18723->921672  avail 18723->890675  wd 0->0  lock 4174->30997
7374901919: bal 49259->111545  avail 49259->0  wd 0->37050  lock 10739->74495
1111111111: bal 11629->11594  avail 11629->6124  wd 0->1970  lock 0->3500
2222222222: bal 1005->1305  avail 1005->500  wd 0->305  lock 0->500
3333333333: bal 9091->9391  avail 9091->8581  wd 0->310  lock 0->500
9350036669: bal 80->500  avail 80->0  wd 0->0  lock 0->500
7056580405: bal 295->1595  avail 295->0  wd 0->595  lock 395->1000
9783506667: bal 0->2500  avail 0->0  wd 0->0  lock 0->2500
8053728527: bal 849->22096  avail 849->250  wd 0->3848  lock 7799->17998
9896060403: bal 500->500  avail 500->0  wd 0->500  lock 0->0
8814977066: bal 110->1610  avail 110->0  wd 0->110  lock 425->1500
9466343336: bal 0->500  avail 0->0  wd 0->0  lock 0->500
9057123533: bal 4066->30623  avail 4066->0  wd 0->11125  lock 9244->19498
7404638312: bal 620->920  avail 620->0  wd 0->420  lock 0->500
9671544772: bal 3051->15548  avail 3051->0  wd 0->5550  lock 4499->9998
9549543640: bal 0->2000  avail 0->0  wd 0->0  lock 0->2000
8168659160: bal 450->1450  avail 450->0  wd 0->450  lock 575->1000
7877905787: bal 9260->13260  avail 9260->1061  wd 0->4200  lock 0->7999
9992899497: bal 7494->27491  avail 7494->0  wd 0->11493  lock 7199->15998
9350999830: bal 140->1440  avail 140->0  wd 0->440  lock 440->1000
9588318670: bal 0->1500  avail 0->0  wd 0->0  lock 455->1500
8502888028: bal 18669->33666  avail 18669->0  wd 0->18668  lock 4499->14998
9812959708: bal 1125->16122  avail 1125->0  wd 0->1124  lock 4624->14998
9783329022: bal 0->2000  avail 0->0  wd 0->0  lock 0->2000
8168658731: bal 4400->16897  avail 4400->0  wd 0->6899  lock 4749->9998
7206182440: bal 510->810  avail 510->0  wd 0->310  lock 0->500
9812959904: bal 49->5000  avail 49->1  wd 0->0  lock 0->4999
8607816132: bal 100->1600  avail 100->0  wd 0->100  lock 485->1500
7056720947: bal 550->1550  avail 550->0  wd 0->550  lock 725->1000
8607850446: bal 2875->5375  avail 2875->1  wd 0->375  lock 0->4999
9416829809: bal 455->955  avail 455->0  wd 0->455  lock 215->500
7740987000: bal 9001->19000  avail 9001->1  wd 0->9000  lock 5249->9999
9053328407: bal 25->525  avail 25->0  wd 0->25  lock 215->500
8571042048: bal 900->1900  avail 900->0  wd 0->900  lock 525->1000
7015903035: bal 155->2655  avail 155->0  wd 0->155  lock 1480->2500
9467089694: bal 165->665  avail 165->0  wd 0->165  lock 275->500
9350061549: bal 110->610  avail 110->0  wd 0->110  lock 440->500
9817149715: bal 12601->30600  avail 12601->1  wd 0->12600  lock 11699->17999
9034610868: bal 10->510  avail 10->0  wd 0->10  lock 380->500
8209894967: bal 9900->31899  avail 9900->1  wd 0->9899  lock 13599->21999
9729959893: bal 375->1375  avail 375->0  wd 0->375  lock 650->1000
9468012944: bal 15->515  avail 15->0  wd 0->15  lock 290->500
7496004749: bal 309->6309  avail 309->0  wd 0->2809  lock 2915->3500
9352526592: bal 3301->25300  avail 3301->1  wd 0->3300  lock 14199->21999
8168616188: bal 250->1250  avail 250->0  wd 0->250  lock 550->1000
9896489698: bal 10598->11598  avail 10598->0  wd 0->10598  lock 650->1000
9217263032: bal 425->1425  avail 425->0  wd 0->425  lock 750->1000
9812260503: bal 7750->17749  avail 7750->1  wd 0->7749  lock 7499->9999
8168944855: bal 15->515  avail 15->0  wd 0->15  lock 365->500
9466482378: bal 11701->29700  avail 11701->1  wd 0->11700  lock 12149->17999
8168768803: bal 5251->15250  avail 5251->1  wd 0->5250  lock 7499->9999
9996141237: bal 200->700  avail 200->0  wd 0->200  lock 380->500
7496069016: bal 10->510  avail 10->0  wd 0->10  lock 500->500
7015157531: bal 15->515  avail 15->0  wd 0->15  lock 365->500
9992808828: bal 145->645  avail 145->0  wd 0->145  lock 365->500
8685878516: bal 4526->26525  avail 4526->3001  wd 0->1525  lock 16599->21999
7209999953: bal 505->1005  avail 505->0  wd 0->505  lock 380->500
7232005634: bal 130->630  avail 130->0  wd 0->130  lock 380->500
8905007801: bal 120->620  avail 120->0  wd 0->120  lock 380->500
8708938254: bal 25->525  avail 25->0  wd 0->25  lock 425->500
9588773461: bal 195->3500  avail 195->2000  wd 0->0  lock 1340->1500
7412943748: bal 175->675  avail 175->0  wd 0->175  lock 395->500
9536885143: bal 160->660  avail 160->0  wd 0->160  lock 410->500
9817296491: bal 35->535  avail 35->0  wd 0->35  lock 425->500
9333333882: bal 135->635  avail 135->0  wd 0->135  lock 425->500
8059685040: bal 135->635  avail 135->0  wd 0->135  lock 425->500
6367098209: bal 0->500  avail 0->500  wd 0->0  lock 0->0
8094767648: bal 98->10097  avail 98->1  wd 0->97  lock 8999->9999
6378787485: bal 1351->19350  avail 1351->1  wd 0->1350  lock 17549->17999
9053573175: bal 30->530  avail 30->0  wd 0->30  lock 470->500
9694792844: bal 0->1000  avail 0->0  wd 0->500  lock 485->500
9509445762: bal 151->7150  avail 151->1  wd 0->150  lock 6949->6999
9549308175: bal 75->1075  avail 75->0  wd 0->75  lock 950->1000
7374886081: bal 75->1075  avail 75->0  wd 0->75  lock 975->1000
8949248421: bal 751->10750  avail 751->1  wd 0->750  lock 9749->9999
`;

type Row = {
  phone: string;
  oldBal: number; newBal: number;
  oldAvail: number; newAvail: number;
  oldWd: number; newWd: number;
  oldLock: number; newLock: number;
};

function parseLog(log: string): Row[] {
  const re = /(\d{10}):\s*bal\s+(\d+)->(\d+)\s+avail\s+(\d+)->(\d+)\s+wd\s+(\d+)->(\d+)\s+lock\s+(\d+)->(\d+)/g;
  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    rows.push({
      phone: m[1],
      oldBal: +m[2], newBal: +m[3],
      oldAvail: +m[4], newAvail: +m[5],
      oldWd: +m[6], newWd: +m[7],
      oldLock: +m[8], newLock: +m[9],
    });
  }
  return rows;
}

async function main() {
  const rows = parseLog(LOG);
  console.log(`[revert] ${rows.length} wallets parsed — ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);

  let reverted = 0;
  let skippedDrift = 0;
  let notFound = 0;

  for (const r of rows) {
    const user = await prisma.user.findUnique({ where: { phone: r.phone } });
    if (!user) {
      console.warn(`  ! ${r.phone}: user not found — skip`);
      notFound++;
      continue;
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
    if (!wallet) {
      console.warn(`  ! ${r.phone}: wallet not found — skip`);
      notFound++;
      continue;
    }

    // Drift guard: current must still equal the backfilled NEW state.
    const matchesNew =
      wallet.balance === r.newBal &&
      wallet.available === r.newAvail &&
      wallet.withdrawable === r.newWd &&
      wallet.locked === r.newLock;

    if (!matchesNew) {
      console.warn(
        `  ! ${r.phone}: DRIFT — current(bal ${wallet.balance} avail ${wallet.available} wd ${wallet.withdrawable} lock ${wallet.locked}) ` +
        `!= backfilled(bal ${r.newBal} avail ${r.newAvail} wd ${r.newWd} lock ${r.newLock}). SKIP (changed since backfill).`
      );
      skippedDrift++;
      continue;
    }

    console.log(
      `  ${r.phone}: bal ${r.newBal}->${r.oldBal}  avail ${r.newAvail}->${r.oldAvail}  wd ${r.newWd}->${r.oldWd}  lock ${r.newLock}->${r.oldLock}`
    );
    reverted++;

    if (!DRY_RUN) {
      await prisma.wallet.update({
        where: { userId: user.id },
        data: {
          balance: r.oldBal,
          available: r.oldAvail,
          withdrawable: r.oldWd,
          locked: r.oldLock,
        },
      });
    }
  }

  console.log(
    `[revert] done — ${reverted} ${DRY_RUN ? 'would revert' : 'reverted'}, ${skippedDrift} drift-skip, ${notFound} not-found`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
