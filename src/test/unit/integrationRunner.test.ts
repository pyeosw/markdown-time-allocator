import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runTests} from '@vscode/test-electron';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('@vscode/test-electron', () => ({runTests: vi.fn()}));

// Exercise the launcher without Electron to verify manifest IDs and CI failure diagnostics.
describe('integration test launcher', () => {
  const originalExitCode = process.exitCode;
  const runnerPath = '../../../scripts/test-integration.mjs';
  const passedReport = {tests: 15, passes: 15, failures: 0, failedTests: []};

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({publisher: 'test-publisher', name: 'test-extension'})
    );
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Publisher/name changes must reach the Extension Host without editing a hardcoded ID.
  it('uses the manifest ID and confirms that all integration tests passed', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(passedReport));
    await import(runnerPath);

    expect(runTests).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionTestsEnv: {
          TIME_CALCULATOR_TEST_EXTENSION_ID: 'test-publisher.test-extension',
          TIME_CALCULATOR_TEST_REPORT: path.resolve(
            '.vscode-test/integration-report.json'
          ),
        },
      })
    );
    expect(console.log).toHaveBeenCalledWith('Integration: 15/15 passed.');
    expect(process.exitCode).toBeUndefined();
  });

  // Failed launches must still expose Mocha's hook names and assertion diagnostics in CI.
  it('prints hook and assertion details even when Electron exits with a failure', async () => {
    const launchError = new Error('Test run failed with code 1');
    vi.mocked(runTests).mockRejectedValueOnce(launchError);
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({
        tests: 0,
        passes: 0,
        failures: 2,
        failedTests: [
          {
            title: 'before each hook',
            message: 'missing ID',
            stack: 'assertion stack',
          },
          {title: 'after each hook', message: 'cleanup failed'},
        ],
      })
    );
    await import(runnerPath);

    expect(console.error).toHaveBeenCalledWith(
      'Integration failure: before each hook'
    );
    expect(console.error).toHaveBeenCalledWith('assertion stack');
    expect(console.error).toHaveBeenCalledWith(
      'Integration failure: after each hook'
    );
    expect(console.error).toHaveBeenCalledWith('cleanup failed');
    expect(console.error).toHaveBeenCalledWith(launchError);
    expect(process.exitCode).toBe(1);
  });

  // A missing report must not replace the original VS Code startup error.
  it('preserves the launch error when no report was written', async () => {
    const launchError = new Error('VS Code could not start');
    const reportError = new Error('report not found');
    vi.mocked(runTests).mockRejectedValueOnce(launchError);
    vi.mocked(readFile).mockRejectedValueOnce(reportError);
    await import(runnerPath);

    expect(console.error).toHaveBeenCalledWith(
      'Could not read the integration test report:',
      reportError
    );
    expect(console.error).toHaveBeenCalledWith(launchError);
    expect(process.exitCode).toBe(1);
  });

  // A zero exit code is insufficient when the report shows skipped or failed execution.
  it.each([
    {tests: 0, passes: 0, failures: 0},
    {tests: 15, passes: 14, failures: 1},
    {tests: 15, passes: 14, failures: 0},
  ])('rejects an incomplete report: %j', async report => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(report));
    await import(runnerPath);

    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Integration tests did not complete:'),
      })
    );
    expect(process.exitCode).toBe(1);
  });
});
