import fs from 'fs';
import readline from 'readline';
import * as server_requests from '../../src/server_requests';
import { findInvestBinaries, createPythonFlaskProcess } from '../../src/main_helpers';
import { argsDictFromObject } from '../../src/utils';

const dotenv = require('dotenv');
dotenv.config();
// This could be optionally configured already in '.env'
if (!process.env.PORT) {
  process.env.PORT = 56788;
}

jest.setTimeout(250000); // This test is slow in CI

const isDevMode = true; // otherwise need to mock process.resourcesPath
beforeAll(async () => {
  const [investExe, investVersion] = await findInvestBinaries(isDevMode);
  createPythonFlaskProcess(investExe);
  // In the CI the flask app takes more than 10x as long to startup.
  // Especially so on macos.
  // So, allowing many retries, especially because the error
  // that is thrown if all retries fail is swallowed by jest
  // and tests try to run anyway.
  await server_requests.getFlaskIsReady({ retries: 201 });
});

afterAll(async () => {
  await server_requests.shutdownPythonProcess();
});

test('invest list items have expected properties', async () => {
  const investList = await server_requests.getInvestModelNames();
  Object.values(investList).forEach((item) => {
    expect(item.internal_name).not.toBeUndefined();
  });
});

test('fetch invest model args spec', async () => {
  const spec = await server_requests.getSpec('carbon');
  const expectedKeys = ['model_name', 'module', 'userguide_html', 'args'];
  expectedKeys.forEach((key) => {
    expect(spec[key]).not.toBeUndefined();
  });
});

test('fetch invest validation', async () => {
  const spec = await server_requests.getSpec('carbon');
  // it's okay to validate even if none of the args have values yet
  const argsDict = argsDictFromObject(spec.args);
  const payload = {
    model_module: spec.module,
    args: JSON.stringify(argsDict),
  };

  const results = await server_requests.fetchValidation(payload);
  // There's always an array of arrays, where each child array has
  // two elements: 1) an array of invest arg keys, 2) string message
  expect(results[0]).toHaveLength(2);
});

test('write parameters to file and parse them from file', async () => {
  const spec = await server_requests.getSpec('carbon');
  const argsDict = argsDictFromObject(spec.args);
  const filepath = 'tests/data/foo.json';
  const payload = {
    parameterSetPath: filepath,
    moduleName: spec.module,
    args: JSON.stringify(argsDict),
    relativePaths: true,
  };

  // First test the data is written
  await server_requests.writeParametersToFile(payload);
  const data = JSON.parse(fs.readFileSync(filepath));
  const expectedKeys = [
    'args',
    'invest_version',
    'model_name'
  ];
  expectedKeys.forEach((key) => {
    expect(data[key]).not.toBeUndefined();
  });

  // Second test the datastack is read and parsed
  const data2 = await server_requests.fetchDatastackFromFile(filepath);
  const expectedKeys2 = [
    'type',
    'args',
    'invest_version',
    'module_name',
    'model_run_name',
    'model_human_name',
  ];
  expectedKeys2.forEach((key) => {
    expect(data2[key]).not.toBeUndefined();
  });
  fs.unlinkSync(filepath);
});

test('write parameters to python script', async () => {
  const modelName = 'carbon'; // as appearing in `invest list`
  const spec = await server_requests.getSpec(modelName);
  const argsDict = argsDictFromObject(spec.args);
  const filepath = 'tests/data/foo.py';
  const payload = {
    filepath: filepath,
    modelname: modelName,
    pyname: spec.module,
    args: JSON.stringify(argsDict),
  };
  await server_requests.saveToPython(payload);

  const file = readline.createInterface({
    input: fs.createReadStream(filepath),
    crlfDelay: Infinity,
  });
  // eslint-disable-next-line
  for await (const line of file) {
    expect(`${line}`).toBe('# coding=UTF-8');
    break;
  }
  fs.unlinkSync(filepath);
});

test('validate the UI spec', async () => {
  const models = await server_requests.getInvestModelNames();
  const modelInternalNames = Object.keys(models).map(
    key => models[key].internal_name);
  const uiSpec = require('../../src/ui_config');
  // get the args spec for each model
  const argsSpecs = await Promise.all(modelInternalNames.map(
    async model => await server_requests.getSpec(model)
  ));

  argsSpecs.forEach((argsSpec) => {
    // make sure that we actually got an args spec
    expect(argsSpec.model_name).toBeDefined();
    let has_order_property = false;
    // expect each arg in the UI spec to exist in the args spec
    for (const property in uiSpec[argsSpec.model_name]) {
      if (property === 'order') {
        has_order_property = true;
        // 'order' is a 2D array of arg names
        const order_array = uiSpec[argsSpec.model_name].order.flat();
        const order_set = new Set(order_array);
        // expect there to be no duplicated args in the order
        expect(order_array.length).toEqual(order_set.size);
        order_array.forEach(arg => {
            expect(argsSpec.args[arg]).toBeDefined();
        });
      } else {
        // for other properties, each key is an arg
        Object.keys(uiSpec[argsSpec.model_name][property]).forEach(arg => {
          expect(argsSpec.args[arg]).toBeDefined();
        });
      }
    }
    expect(has_order_property).toBe(true);
  });
});
