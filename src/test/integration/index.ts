import Mocha from 'mocha';

import {registerTests} from './extension.test';

/** Runs the Mocha integration suite inside a dedicated VSCode Extension Host. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ui: 'tdd', timeout: 20000, color: true});
  mocha.suite.emit('pre-require', globalThis, 'integration', mocha);
  registerTests();
  await new Promise<void>((resolve, reject) => {
    const runner = mocha.run(failures => {
      const reportPath = process.env.TIME_CALCULATOR_TEST_REPORT;
      if (reportPath) writeFileSync(reportPath, JSON.stringify(runner.stats));
      if (failures) reject(new Error(`${failures} integration tests failed`));
      else resolve();
    });
  });
}
import {writeFileSync} from 'node:fs';
