import path from 'node:path';
import {mkdir, readFile, rm} from 'node:fs/promises';
import {runTests} from '@vscode/test-electron';

// Electron-based terminals may otherwise launch Code as a plain Node process.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  const reportPath = path.resolve('.vscode-test/integration-report.json');
  await mkdir(path.dirname(reportPath), {recursive: true});
  await rm(reportPath, {force: true});
  await runTests({
    extensionDevelopmentPath: path.resolve('.'),
    extensionTestsPath: path.resolve('out/integration/index.cjs'),
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionTestsEnv: {TIME_CALCULATOR_TEST_REPORT: reportPath},
    launchArgs: [
      '--user-data-dir',
      path.resolve('.vscode-test/user-data'),
      '--extensions-dir',
      path.resolve('.vscode-test/extensions'),
      '--disable-workspace-trust',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
      '--new-window',
      '--disable-telemetry',
      '--disable-extension=github.copilot-chat',
      '--log=error',
    ],
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.tests < 1 || report.failures || report.passes !== report.tests) {
    throw new Error(
      `Integration tests did not complete: ${JSON.stringify(report)}`
    );
  }
  console.log(`Integration: ${report.passes}/${report.tests} passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
