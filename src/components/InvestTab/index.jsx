import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, exec } from 'child_process';
import React from 'react';
import PropTypes from 'prop-types';

import TabPane from 'react-bootstrap/TabPane';
import TabContent from 'react-bootstrap/TabContent';
import TabContainer from 'react-bootstrap/TabContainer';
import Nav from 'react-bootstrap/Nav';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Spinner from 'react-bootstrap/Spinner';

import SetupTab from '../SetupTab';
import LogTab from '../LogTab';
import ResourcesLinks from '../ResourcesLinks';
import { getSpec, writeParametersToFile } from '../../server_requests';
import { findMostRecentLogfile, cleanupDir } from '../../utils';
import { fileRegistry } from '../../constants';
import { getLogger } from '../../logger';
import { dragOverHandlerNone } from '../../utils.js';


const logger = getLogger(__filename.split('/').slice(-1)[0]);

// to translate to the invest CLI's verbosity flag:
const LOGLEVELMAP = {
  DEBUG: '--debug',
  INFO: '-vvv',
  WARNING: '-vv',
  ERROR: '-v',
};

/** Get an invest model's ARGS_SPEC when a model button is clicked.
 *
 * @param {string} modelName - as in a model name appearing in `invest list`
 * @returns {object} destructures to:
 *   { modelSpec, argsSpec, uiSpec }
 */
async function investGetSpec(modelName) {
  const spec = await getSpec(modelName);
  if (spec) {
    const { args, ...modelSpec } = spec;
    const uiSpecs = require('../../ui_config');
    const uiSpec = uiSpecs[modelSpec.model_name];
    if (uiSpec) {
      return { modelSpec: modelSpec, argsSpec: args, uiSpec: uiSpec };
    } else {
      logger.error(`no UI spec found for ${modelName}`);
    } 
  } else {
    logger.error(`no args spec found for ${modelName}`);
  }  
  return undefined;
}

/**
 * Render an invest model setup form, log display, etc.
 * Manage launching of an invest model in a child process.
 * And manage saves of executed jobs to a persistent store.
 */
export default class InvestTab extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      activeTab: 'setup',
      modelSpec: null, // ARGS_SPEC dict with all keys except ARGS_SPEC.args
      argsSpec: null, // ARGS_SPEC.args, the immutable args stuff
      logStdErr: null, // stderr data from the invest subprocess
      jobStatus: null, // 'running', 'error', 'success'
      procID: null,
    };

    this.argsToJsonFile = this.argsToJsonFile.bind(this);
    this.investExecute = this.investExecute.bind(this);
    this.switchTabs = this.switchTabs.bind(this);
    this.terminateInvestProcess = this.terminateInvestProcess.bind(this);
    this.investRun = undefined;
  }

  async componentDidMount() {
    // If these dir already exists, this will err and pass
    fs.mkdir(fileRegistry.TEMP_DIR, (err) => {});
    const { job } = this.props;
    const {
      modelSpec, argsSpec, uiSpec
    } = await investGetSpec(job.metadata.modelRunName);
    this.setState({
      modelSpec: modelSpec,
      argsSpec: argsSpec,
      uiSpec: uiSpec,
      jobStatus: job.metadata.status,
    }, () => { this.switchTabs('setup'); });
  }

  /** Write an invest args JSON file for passing to invest cli.
   *
   * Outsourcing this to natcap.invest.datastack via flask ensures
   * a compliant json with an invest version string.
   *
   * @param {string} datastackPath - path to a JSON file.
   * @param {object} argsValues - the invest "args dictionary"
   *   as a javascript object
   */
  async argsToJsonFile(datastackPath, argsValues) {
    const payload = {
      parameterSetPath: datastackPath,
      moduleName: this.state.modelSpec.module,
      relativePaths: false,
      args: JSON.stringify(argsValues),
    };
    await writeParametersToFile(payload);
  }

  /** Spawn a child process to run an invest model via the invest CLI.
   *
   * e.g. `invest -vvv run <model> --headless -d <datastack path>`
   *
   * When the process starts (on first stdout callback), job metadata is saved
   * and local state is updated to display the invest log.
   * When the process exits, job metadata is updated with final status of run.
   *
   * @param {object} argsValues - the invest "args dictionary"
   *   as a javascript object
   */
  async investExecute(argsValues) {
    const {
      job,
      investExe,
      investSettings,
      saveJob,
    } = this.props;
    const args = { ...argsValues };
    // Not strictly necessary, but resolving to a complete path
    // here to be extra certain we avoid unexpected collisions
    // of workspaceHash, which uniquely ids a job in the database
    // in part by it's workspace directory.
    args.workspace_dir = path.resolve(argsValues.workspace_dir);

    job.setProperty('argsValues', args);
    job.setProperty('status', 'running');

    // Setting this very early in the click handler so the Execute button
    // can display an appropriate visual cue when it's clicked
    this.setState({
      jobStatus: job.metadata.status,
    });

    // Write a temporary datastack json for passing to invest CLI
    const tempDir = fs.mkdtempSync(path.join(
      fileRegistry.TEMP_DIR, 'data-'
    ));
    const datastackPath = path.join(tempDir, 'datastack.json');
    await this.argsToJsonFile(datastackPath, args);

    const cmdArgs = [
      LOGLEVELMAP[investSettings.loggingLevel],
      'run',
      job.metadata.modelRunName,
      '--headless',
      `-d "${datastackPath}"`,
    ];
    if (process.platform !== 'win32') {
      this.investRun = spawn(path.basename(investExe), cmdArgs, {
        env: { PATH: path.dirname(investExe) },
        shell: true, // without shell, IOError when datastack.py loads json
        detached: true, // counter-intuitive, but w/ true: invest terminates when this shell terminates
      });
    } else { // windows
      this.investRun = spawn(path.basename(investExe), cmdArgs, {
        env: { PATH: path.dirname(investExe) },
        shell: true,
      });
    }

    // There's no general way to know that a spawned process started,
    // so this logic to listen once on stdout seems like the way.
    this.investRun.stdout.once('data', async () => {
      const logfile = await findMostRecentLogfile(args.workspace_dir);
      job.setProperty('logfile', logfile);
      // TODO: handle case when logfile is still undefined?
      // Could be if some stdout is emitted before a logfile exists.
      logger.debug(`invest logging to: ${job.metadata.logfile}`);
      this.setState(
        {
          procID: this.investRun.pid,
        }, () => {
          this.switchTabs('log');
          saveJob(job);
        }
      );
    });

    // Capture stderr to a string separate from the invest log
    // so that it can be displayed separately when invest exits.
    // And because it could actually be stderr emitted from the
    // invest CLI or even the shell, rather than the invest model,
    // in which case it's useful to logger.debug too.
    let stderr = Object.assign('', this.state.logStdErr);
    this.investRun.stderr.on('data', (data) => {
      logger.debug(`${data}`);
      stderr += `${data}${os.EOL}`;
      this.setState({
        logStdErr: stderr,
      });
    });

    // Set some state when the invest process exits and update the app's
    // persistent database by calling saveJob.
    this.investRun.on('exit', (code) => {
      logger.debug(code);
      if (code === 0) {
        job.setProperty('status', 'success');
      } else {
        // Invest CLI exits w/ code 1 when it catches errors,
        // Models exit w/ code 255 (on all OS?) when errors raise from execute()
        // Windows taskkill yields exit code 1
        // Non-windows process.kill yields exit code null
        job.setProperty('status', 'error');
      }
      this.setState({
        jobStatus: job.metadata.status,
        procID: null,
      }, () => {
        saveJob(job);
        fs.unlink(datastackPath, (err) => {
          if (err) { logger.error(err); }
          fs.rmdir(tempDir, (e) => {
            if (e) { logger.error(e); }
          });
        });
      });
    });
  }

  terminateInvestProcess(pid) {
    if (pid) {
      if (this.state.jobStatus === 'running') {
        if (process.platform !== 'win32') {
          // the '-' prefix on pid sends signal to children as well
          process.kill(-pid, 'SIGTERM');
        } else {
          exec(`taskkill /pid ${pid} /t /f`);
        }
      }
      // this replaces any stderr that might exist, but that's
      // okay since the user requested terminating the process.
      this.setState({
        logStdErr: 'Run Canceled',
      });
    }
  }

  /** Change the tab that is currently visible.
   *
   * @param {string} key - the value of one of the Nav.Link eventKey.
   */
  switchTabs(key) {
    this.setState(
      { activeTab: key }
    );
  }

  render() {
    const {
      activeTab,
      modelSpec,
      argsSpec,
      uiSpec,
      jobStatus,
      logStdErr,
      procID,
    } = this.state;
    const {
      navID,
      modelRunName,
      argsValues,
      logfile,
    } = this.props.job.metadata;

    // Don't render the model setup & log until data has been fetched.
    if (!modelSpec) {
      return (<div />);
    }

    const isRunning = jobStatus === 'running';
    const logDisabled = !logfile;
    const sidebarSetupElementId = `sidebar-setup-${navID}`;
    const sidebarFooterElementId = `sidebar-footer-${navID}`;


    return (
      <TabContainer activeKey={activeTab} id="invest-tab">
        <Row>
          <Col sm={3} className="invest-sidebar-col" onDragOver={dragOverHandlerNone}>
            <Nav
              className="flex-column"
              id="vertical tabs"
              variant="pills"
              activeKey={activeTab}
              onSelect={this.switchTabs}
            >
              <Nav.Item>
                <Nav.Link eventKey="setup">
                  Setup
                </Nav.Link>
              </Nav.Item>
              <div
                className="sidebar-setup"
                id={sidebarSetupElementId}
              />
              <Nav.Item>
                <Nav.Link eventKey="log" disabled={logDisabled}>
                  Log
                  { isRunning
                  && (
                    <Spinner
                      animation="border"
                      size="sm"
                      role="status"
                      aria-hidden="true"
                    />
                  )}
                </Nav.Link>
              </Nav.Item>
            </Nav>
            <div className="sidebar-row">
              <ResourcesLinks
                moduleName={modelRunName}
                docs={modelSpec.userguide_html}
              />
            </div>
            <div
              className="sidebar-row sidebar-footer"
              id={sidebarFooterElementId}
            />
          </Col>
          <Col sm={9} className="invest-main-col">
            <TabContent>
              <TabPane eventKey="setup" title="Setup">
                <SetupTab
                  pyModuleName={modelSpec.module}
                  modelName={modelSpec.model_name}
                  argsSpec={argsSpec}
                  uiSpec={uiSpec}
                  argsInitValues={argsValues}
                  investExecute={this.investExecute}
                  argsToJsonFile={this.argsToJsonFile}
                  nWorkers={this.props.investSettings.nWorkers}
                  sidebarSetupElementId={sidebarSetupElementId}
                  sidebarFooterElementId={sidebarFooterElementId}
                  isRunning={isRunning}
                />
              </TabPane>
              <TabPane eventKey="log" title="Log">
                <LogTab
                  jobStatus={jobStatus}
                  logfile={logfile}
                  logStdErr={logStdErr}
                  terminateInvestProcess={this.terminateInvestProcess}
                  procID={procID}
                  pyModuleName={modelSpec.module}
                  sidebarFooterElementId={sidebarFooterElementId}
                />
              </TabPane>
            </TabContent>
          </Col>
        </Row>
      </TabContainer>
    );
  }
}

InvestTab.propTypes = {
  job: PropTypes.shape({
    metadata: PropTypes.shape({
      modelRunName: PropTypes.string.isRequired,
      modelHumanName: PropTypes.string.isRequired,
      navID: PropTypes.string.isRequired,
      argsValues: PropTypes.object,
      logfile: PropTypes.string,
      status: PropTypes.string,
    }),
    save: PropTypes.func.isRequired,
    setProperty: PropTypes.func.isRequired,
  }).isRequired,
  investExe: PropTypes.string.isRequired,
  investSettings: PropTypes.shape({
    nWorkers: PropTypes.string,
    loggingLevel: PropTypes.string,
  }).isRequired,
  saveJob: PropTypes.func.isRequired,
};
