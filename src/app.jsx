import crypto from 'crypto';
import React from 'react';
import PropTypes from 'prop-types';

import TabPane from 'react-bootstrap/TabPane';
import TabContent from 'react-bootstrap/TabContent';
import TabContainer from 'react-bootstrap/TabContainer';
import Navbar from 'react-bootstrap/Navbar';
import Nav from 'react-bootstrap/Nav';
import Button from 'react-bootstrap/Button';

import HomeTab from './components/HomeTab';
import InvestTab from './components/InvestTab';
import LoadButton from './components/LoadButton';
import SettingsModal from './components/SettingsModal';
import { getInvestModelNames } from './server_requests';
import { getLogger } from './logger';
import InvestJob from './InvestJob';
import { dragOverHandlerNone } from './utils.js';

const logger = getLogger(__filename.split('/').slice(-1)[0]);

/** This component manages any application state that should persist
 * and be independent from properties of a single invest job.
 */
export default class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      activeTab: 'home',
      openJobs: [],
      investList: {},
      recentJobs: [],
      investSettings: {},
    };
    this.saveSettings = this.saveSettings.bind(this);
    this.switchTabs = this.switchTabs.bind(this);
    this.openInvestModel = this.openInvestModel.bind(this);
    this.closeInvestModel = this.closeInvestModel.bind(this);
    this.saveJob = this.saveJob.bind(this);
    this.clearRecentJobs = this.clearRecentJobs.bind(this);
  }

  /** Initialize the list of available invest models and recent invest jobs. */
  async componentDidMount() {
    const investList = await getInvestModelNames();
    const recentJobs = await InvestJob.getJobStore();
    // TODO: also load and set investSettings from a cached state, instead
    // of always re-setting to these hardcoded values on first launch?

    this.setState({
      investList: investList,
      recentJobs: recentJobs,
      investSettings: {
        nWorkers: '-1',
        loggingLevel: 'INFO',
      },
    });
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

  saveSettings(settings) {
    this.setState({
      investSettings: settings,
    });
  }

  /** Push data for a new InvestTab component to an array.
   *
   * @param {InvestJob} job - as constructed by new InvestJob()
   */
  openInvestModel(job) {
    const navID = crypto.randomBytes(16).toString('hex');
    job.setProperty('navID', navID);
    this.setState((state) => ({
      openJobs: [...state.openJobs, job],
    }), () => this.switchTabs(navID));
  }

  /**
   * Click handler for the close-tab button on an Invest model tab.
   *
   * @param  {string} navID - the eventKey of the tab containing the
   *   InvestTab component that will be removed.
   */
  closeInvestModel(navID) {
    let index;
    const { openJobs } = this.state;
    openJobs.forEach((job) => {
      if (job.metadata.navID === navID) {
        index = openJobs.indexOf(job);
        openJobs.splice(index, 1);
      }
    });
    // Switch to the next tab if there is one, or the previous, or home.
    let switchTo = 'home';
    if (openJobs[index]) {
      switchTo = openJobs[index].metadata.navID;
    } else if (openJobs[index - 1]) {
      switchTo = openJobs[index - 1].metadata.navID;
    }
    this.switchTabs(switchTo);
    this.setState({
      openJobs: openJobs
    });
  }

  /** Save data describing an invest job to a persistent JSON file.
   *
   * @param {object} job - as constructed by new InvestJob()
   */
  async saveJob(job) {
    const recentJobs = await job.save();
    this.setState({
      recentJobs: recentJobs,
    });
  }

  async clearRecentJobs() {
    const recentJobs = await InvestJob.clearStore();
    this.setState({
      recentJobs: recentJobs,
    });
  }

  render() {
    return (
      <TabContainer>
        <Navbar>
          <Navbar.Brand>
            InVEST
          </Navbar.Brand>
        </Navbar>
      </TabContainer>
    );
  }
}

App.propTypes = {
  investExe: PropTypes.string.isRequired,
};
