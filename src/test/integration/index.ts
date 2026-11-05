import Mocha from 'mocha';

import {registerTests} from './extension.test';

/** Runs the Mocha integration suite inside a dedicated VSCode Extension Host. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ui: 'tdd', timeout: 20000, color: true});
  mocha.suite.emit('pre-require', globalThis, 'integration', mocha);
  registerTests();
  const failedTests: Array<{title: string; message: string; stack?: string}> =
    [];
  await new Promise<void>((resolve, reject) => {
    const runner = mocha.run(failures => {
      const reportPath = process.env.TIME_CALCULATOR_TEST_REPORT;
      if (reportPath)
        writeFileSync(
          reportPath,
          JSON.stringify({...runner.stats, failedTests})
        );
      if (failures) reject(new Error(`${failures} integration tests failed`));
      else resolve();
    });
    // Preserve assertion details even when Electron does not forward Mocha's console reporter.
    runner.on('fail', (test, error) => {
      failedTests.push({
        title: test.fullTitle(),
        message: error.message,
        stack: error.stack,
      });
    });
  });
}
import {writeFileSync} from 'node:fs';
