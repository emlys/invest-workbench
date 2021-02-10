import path from 'path';
import fs from 'fs';
import React from 'react';
import { remote } from 'electron';
import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import InvestTab from '../src/components/InvestTab';
import SetupTab from '../src/components/SetupTab';
import {
  getSpec, saveToPython, writeParametersToFile, fetchValidation
} from '../src/server_requests';
import { fileRegistry } from '../src/constants';
import InvestJob from '../src/InvestJob';

jest.mock('../src/server_requests');

function renderInvestTab() {
  const job = new InvestJob({
    modelRunName: 'carbon',
    modelHumanName: 'Carbon Model',
  });
  job.setProperty('navID', 'carbon456asdf');
  const { ...utils } = render(
    <InvestTab
      job={job}
      investExe="foo"
      investSettings={{ nWorkers: '-1', loggingLevel: 'INFO' }}
      saveJob={() => {}}
    />
  );
  return utils;
}

describe('Save InVEST Model Setup Buttons', () => {
  const spec = {
    module: 'natcap.invest.foo',
    model_name: 'FooModel',
    args: {
      workspace: {
        name: 'Workspace',
        type: 'directory',
        about: 'this is a workspace',
      },
      port: {
        name: 'Port',
        type: 'number',
      },
    },
  };

  // args expected to be in the saved JSON / Python dictionary
  const expectedArgKeys = ['workspace', 'n_workers'];

  beforeAll(() => {
    getSpec.mockResolvedValue(spec);
    fetchValidation.mockResolvedValue([]);
    // mock out the whole UI config module
    // brackets around spec.model_name turns it into a valid literal key
    const mockUISpec = {[spec.model_name]: {order: [Object.keys(spec.args)]}}
    jest.mock('../src/ui_config', () => mockUISpec);
  });

  afterAll(() => {
    // the API for removing mocks is confusing (see https://github.com/facebook/jest/issues/7136)
    // not sure why, but resetModules is needed to unmock the ui_config
    jest.resetModules();
    jest.resetAllMocks();
    // Careful with reset because "resetting a spy results
    // in a function with no return value". I had been using spies to observe
    // function calls, but not to mock return values. Spies used for that
    // purpose should be 'restored' not 'reset'. Do that inside the test as-needed.
  });

  test('SaveParametersButton: requests endpoint with correct payload', async () => {
    // mock the server call, instead just returning
    // the payload. At least we can assert the payload is what
    // the flask endpoint needs to build the json file.
    writeParametersToFile.mockImplementation(
      (payload) => payload
    );
    const mockDialogData = {
      filePath: 'foo.json'
    };
    remote.dialog.showSaveDialog.mockResolvedValue(mockDialogData);

    const { findByText } = renderInvestTab();

    const saveButton = await findByText('Save to JSON');
    fireEvent.click(saveButton);

    await waitFor(() => {
      const results = writeParametersToFile.mock.results[0].value;
      expect(Object.keys(results)).toEqual(expect.arrayContaining(
        ['parameterSetPath', 'moduleName', 'relativePaths', 'args']
      ));
      Object.keys(results).forEach((key) => {
        expect(results[key]).not.toBeUndefined();
      });
      const args = JSON.parse(results.args);
      const argKeys = Object.keys(args);
      expect(argKeys).toEqual(expect.arrayContaining(expectedArgKeys));
      argKeys.forEach((key) => {
        expect(typeof args[key]).toBe('string');
      });
      expect(writeParametersToFile).toHaveBeenCalledTimes(1);
    });
  });

  test('SavePythonButton: requests endpoint with correct payload', async () => {
    // mock the server call, instead just returning
    // the payload. At least we can assert the payload is what
    // the flask endpoint needs to build the python script.
    saveToPython.mockImplementation(
      (payload) => payload
    );
    const mockDialogData = { filePath: 'foo.py' };
    remote.dialog.showSaveDialog.mockResolvedValue(mockDialogData);

    const { findByText } = renderInvestTab();

    const saveButton = await findByText('Save to Python script');
    fireEvent.click(saveButton);

    await waitFor(() => {
      const results = saveToPython.mock.results[0].value;
      expect(Object.keys(results)).toEqual(expect.arrayContaining(
        ['filepath', 'modelname', 'pyname', 'args']
      ));
      Object.keys(results).forEach((key) => {
        expect(results[key]).not.toBeUndefined();
      });
      const args = JSON.parse(results.args);
      const argKeys = Object.keys(args);
      expect(argKeys).toEqual(expect.arrayContaining(expectedArgKeys));
      argKeys.forEach((key) => {
        expect(typeof args[key]).toBe('string');
      });
      expect(saveToPython).toHaveBeenCalledTimes(1);
    });
  });

  test('SaveParametersButton: Dialog callback does nothing when canceled', async () => {
    // this resembles the callback data if the dialog is canceled instead of
    // a save file selected.
    const mockDialogData = {
      filePath: ''
    };
    remote.dialog.showSaveDialog.mockResolvedValue(mockDialogData);
    // Spy on this method so we can assert it was never called.
    // Don't forget to restore! Otherwise a 'resetAllMocks'
    // can silently turn this spy into a function that returns nothing.
    const spy = jest.spyOn(InvestTab.prototype, 'argsToJsonFile');

    const { findByText } = renderInvestTab();

    const saveButton = await findByText('Save to JSON');
    fireEvent.click(saveButton);

    // These are the calls that would have triggered if a file was selected
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore(); // restores to unmocked implementation
  });

  test('SavePythonButton: Dialog callback does nothing when canceled', async () => {
    // this resembles the callback data if the dialog is canceled instead of 
    // a save file selected.
    const mockDialogData = {
      filePath: ''
    };
    remote.dialog.showSaveDialog.mockResolvedValue(mockDialogData);
    // Spy on this method so we can assert it was never called.
    // Don't forget to restore! Otherwise the beforeEach will 'resetAllMocks'
    // will silently turn this spy into a function that returns nothing.
    const spy = jest.spyOn(SetupTab.prototype, 'savePythonScript');

    const { findByText } = renderInvestTab();

    const saveButton = await findByText('Save to Python script');
    fireEvent.click(saveButton);

    // These are the calls that would have triggered if a file was selected
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore(); // restores to unmocked implementation
  });
});

describe('InVEST Run Button', () => {
  const spec = {
    module: 'natcap.invest.bar',
    model_name: 'BarModel',
    args: {
      a: {
        name: 'abar',
        type: 'freestyle_string',
      },
      b: {
        name: 'bbar',
        type: 'number',
      },
      c: {
        name: 'cbar',
        type: 'csv',
      },
    },
  };

  beforeAll(() => {
    getSpec.mockResolvedValue(spec);
    // mock out the whole UI config module
    // brackets around spec.model_name turns it into a valid literal key
    let mockUISpec = {[spec.model_name]: {order: [Object.keys(spec.args)]}}
    jest.mock('../src/ui_config', () => mockUISpec);
  });

  afterAll(() => {
    jest.resetModules();
    jest.resetAllMocks();
  });

  test('Changing inputs trigger validation & enable/disable Run', async () => {
    let invalidFeedback = 'is a required key';
    fetchValidation.mockResolvedValue([[['a', 'b'], invalidFeedback]]);

    const {
      findByLabelText,
      findByRole,
    } = renderInvestTab();

    const runButton = await findByRole('button', { name: /Run/ });
    expect(runButton).toBeDisabled();

    const a = await findByLabelText(RegExp(`${spec.args.a.name}`));
    const b = await findByLabelText(RegExp(`${spec.args.b.name}`));

    expect(a).toHaveClass('is-invalid');
    expect(b).toHaveClass('is-invalid');

    // These new values will be valid - Run should enable
    fetchValidation.mockResolvedValue([]);
    fireEvent.change(a, { target: { value: 'foo' } });
    fireEvent.change(b, { target: { value: 1 } });
    await waitFor(() => {
      expect(runButton).toBeEnabled();
    });

    // This new value will be invalid - Run should disable again
    invalidFeedback = 'must be a number';
    fetchValidation.mockResolvedValue([[['b'], invalidFeedback]]);
    fireEvent.change(b, { target: { value: 'one' } });
    await waitFor(() => {
      expect(runButton).toBeDisabled();
    });
  });
});
