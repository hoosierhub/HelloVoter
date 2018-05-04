import React, { PureComponent } from 'react';

import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  View,
  Linking,
  ScrollView,
  PermissionsAndroid,
  Platform,
  TouchableHighlight,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  DeviceEventEmitter,
} from 'react-native';

import { NavigationActions } from 'react-navigation'
import { Dropbox } from 'dropbox';
import DeviceInfo from 'react-native-device-info';
import storage from 'react-native-storage-wrapper';
import Icon from 'react-native-vector-icons/FontAwesome';
import sha1 from 'sha1';
import Permissions from 'react-native-permissions';
import RNGLocation from 'react-native-google-location';
import RNGooglePlaces from 'react-native-google-places';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps';
import encoding from 'encoding';
import { transliterate as tr } from 'transliteration/src/main/browser';
import { _doGeocode } from '../../common';
import KnockPage from '../KnockPage';
import Modal from 'react-native-simple-modal';
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import t from 'tcomb-form-native';
import _ from 'lodash';

TimeAgo.locale(en);

var Form = t.form.Form;

var formStreet = t.struct({
  'street': t.String,
});
var formCity = t.struct({
  'multi_unit': t.Boolean,
  'city': t.String,
});
var formState = t.struct({
  'state': t.String,
  'zip': t.String,
});

const formStyleRow = _.cloneDeep(t.form.Form.stylesheet);
formStyleRow.fieldset = {
  flexDirection: 'row'
};
formStyleRow.formGroup.normal.flex = 1;
formStyleRow.formGroup.error.flex = 1;

const formOptRow = {
  stylesheet: formStyleRow,
};

export default class App extends PureComponent {

  constructor(props) {
    super(props);

    this.state = {
      loading: false,
      exportRunning: false,
      syncRunning: false,
      syncTurfRunning: false,
      serviceError: null,
      locationAccess: null,
      myPosition: {latitude: null, longitude: null},
      region: {latitudeDelta: 0.004, longitudeDelta: 0.004},
      currentNode: null,
      fAddress: {},
      myNodes: { nodes: [], last_synced: 0 },
      turfNodes: { nodes: [] },
      asyncStorageKey: 'OV_CANVASS_PINS@'+props.navigation.state.params.form.id,
      settingsStorageKey: 'OV_CANVASS_SETTINGS',
      canvassSettings: {},
      DisclosureKey : 'OV_DISCLOUSER',
      isModalVisible: false,
      isKnockMenuVisible: false,
      showDisclosure: "true",
      dbx: props.navigation.state.params.dbx,
      form: props.navigation.state.params.form,
      user: props.navigation.state.params.user,
    };

    this.markers = [];
    this.idx = {};
    this.idc = {};

    this.onChange = this.onChange.bind(this);
  }

  onLocationChange (e: Event) {
    let { myPosition } = this.state;
    myPosition = {
      latitude: e.Latitude,
      longitude: e.Longitude,
    };
    this.setState({ myPosition });
  }

  requestLocationPermission = async () => {

    access = false;

    try {
      res = await Permissions.request('location');
      if (res === "authorized") access = true;
    } catch(error) {
      // nothing we can do about it
    }

    if (access === true) {
      if (Platform.OS === 'android') {
        if (!this.evEmitter) {
          if (RNGLocation.available() === false) {
            this.setState({ serviceError: true });
          } else {
            this.evEmitter = DeviceEventEmitter.addListener('updateLocation', this.onLocationChange.bind(this));
            RNGLocation.reconnect();
            RNGLocation.getLocation();
          }
        }
      } else {
        this.getLocation();
        this.timerID = setInterval(() => this.getLocation(), 5000);
      }
    }

    this.setState({ locationAccess: access });
  }
  componentDidMount() {
    this.requestLocationPermission();
    this._getCanvassSettings();
    this._getNodesAsyncStorage();
  this.LoadDisclosure(); //Updates showDisclosure state if the user previously accepted
  }

  getLocation() {
    navigator.geolocation.getCurrentPosition((position) => {
      this.setState({ myPosition: position.coords });
    },
    (error) => { },
    { enableHighAccuracy: true, timeout: 2000, maximumAge: 1000 });
  }

  componentWillUnmount() {
    if (Platform.OS === 'ios') {
      clearInterval(this.timerID);
    } else {
      if (this.evEmitter) {
        RNGLocation.disconnect();
        this.evEmitter.remove();
      }
    }
  }

  showConfirmAddress() {
    const { myPosition } = this.state;

    this.setState({
      loading: true,
      isModalVisible: true,
    });

    setTimeout(async () => {
      try {
        let res = await _doGeocode(myPosition.longitude, myPosition.latitude);

        if (!res.error) {
          let arr = res.address.split(", ");
          let country = arr[arr.length-1]; // unused
          let state_zip = arr[arr.length-2];
          let fAddress = {
            state: (state_zip?state_zip.split(" ")[0]:null),
            zip: (state_zip?state_zip.split(" ")[1]:null),
            city: arr[arr.length-3],
            street: arr[arr.length-4],
          };

          this.setState({fAddress});
        }
      } catch (error) {}
      this.setState({loading: false})
    }, 550);
  }

  onChange(fAddress) {
    this.setState({fAddress});
  }

  getEpoch() {
    return Math.floor(new Date().getTime() / 1000)
  }

  doConfirmAddress = async () => {
    const { myPosition, myNodes, form } = this.state;

    let jsonStreet = this.refs.formStreet.getValue();
    let jsonCity = this.refs.formCity.getValue();
    let jsonState = this.refs.formState.getValue();

    if (jsonStreet === null || jsonCity === null || jsonState === null) return;

    try {
      await this.map.animateToCoordinate(myPosition, 500)
    } catch (error) {}

    let epoch = this.getEpoch();
    let fAddress = {
      street: jsonStreet.street.trim(),
      multi_unit: jsonCity.multi_unit,
      city: jsonCity.city.trim(),
      state: jsonState.state.trim(),
      zip: jsonState.zip.trim(),

    };
    let address = [fAddress.street, fAddress.city, fAddress.state, fAddress.zip];
    let node = {
      type: "address",
      id: sha1(JSON.stringify(address)),
      latlng: {latitude: myPosition.latitude, longitude: myPosition.longitude},
      address: address,
      multi_unit: jsonCity.multi_unit,
    };

    node = this._addNode(node);

    this.idx[node.id] = node;
    if (node.partent_id) {
      if (!this.idc[nodes.parent_id]) this.idc[node.parent_id] = [];
      this.idc[node.parent_id].unshift(nodes);
    }

    this.updateMarkers();
    this.setState({ fAddress: fAddress, isModalVisible: false });
    this.doMarkerPress(node);
  }

  doMarkerPress(node) {
    const { navigate } = this.props.navigation;

    this.setState({currentNode: node});

    if (node.multi_unit === true)
      navigate('ListMultiUnit', {refer: this, node: node});
    else
      this.setState({isKnockMenuVisible: true});
  }

  _addNode(node) {
    let { myNodes } = this.state;
    let epoch = this.getEpoch();

    node.created = epoch;
    node.updated = epoch;
    node.canvasser = this.state.user.dropbox.name.display_name;
    if (!node.id) node.id = sha1(epoch+JSON.stringify(node)+this.state.currentNode.id);

    // chech for duplicate address pins
    let check = this.getNodeByIdStore(node.id, myNodes);

    if (!check.id)
      myNodes.nodes.push(node);
    else
      node = check;

    this.idx[node.id] = node;
    if (node.parent_id) {
      if (!this.idc[node.parent_id]) this.idc[node.parent_id] = [];
      this.idc[node.parent_id].unshift(node);
    }

    this._saveNodes(myNodes, true);

    return node;
  }

  getLatestSurvey(id) {
    let nodes = this.getChildNodesByIdType(id, "survey").sort(this.dynamicSort('updated'));
    let info = {};
    const timeAgo = new TimeAgo('en-US')

    if (nodes.length)  {
      let last = nodes[nodes.length-1];
      if (last.survey) {
        info.FullName = last.survey.FullName;
        info.PartyAffiliation = last.survey.PartyAffiliation;
      }
      info.LastVisted = timeAgo.format(new Date(last.updated*1000));
    };

    return info;
  }

  getLatestSurveyInfoByProp(id, prop) {
    let nodes = this.getChildNodesByIdType(id, "survey").sort(this.dynamicSort('updated')).reverse();

    for (let n in nodes) {
      let node = nodes[n];
      if (node.survey && node.survey[prop]) return node.survey;
    }

    return {};
  }

  LoadDisclosure = async () => {
    try {
      const value = await storage.get(this.state.DisclosureKey);
      if (value !== null) {
        this.setState({showDisclosure : value});
      }
    } catch (error) {}
  }

  SaveDisclosure = async () => {
    try {
      await storage.set(this.state.DisclosureKey, "false");
    } catch (error) {}
  }

  _nodesFromJSON(str) {
    let store;

    try {
      store = JSON.parse(str);
    } catch (e) { console.warn(e); }

    if (!store.nodes) store.nodes = [];

    // check for old version 1 format and convert
    if (store.pins) {
      for (let p in store.pins) {
        let pin = store.pins[p];

        // address had "unit" in it - splice it out
        let unit = pin.address.splice(1, 1);
        // "city" started with a space... a bug
        pin.address[1] = pin.address[1].trim();

        // ensure latlng aren't strings
        if (pin.latlng) {
          pin.latlng.longitude = parseFloat(pin.latlng.longitude);
          pin.latlng.latitude = parseFloat(pin.latlng.latitude);
        }

        let id = sha1(JSON.stringify(pin.address));
        let pid = id;

        // chech for duplicate address pins
        let check = this.getNodeById(id);

        if (!check.id) {
          store.nodes.push({
            type: "address",
            id: id,
            created: pin.id,
            updated: pin.id,
            canvasser: store.canvasser,
            latlng: pin.latlng,
            address: pin.address,
            multi_unit: ((unit && unit[0] !== null && unit[0] !== "")?true:false),
          });
        }

        if (unit && unit[0] !== null && unit[0] !== "") {
          id = sha1(pid+unit);
          store.nodes.push({
            type: "unit",
            id: id,
            created: pin.id,
            updated: pin.id,
            canvasser: store.canvasser,
            parent_id: pid,
            unit: unit[0],
          });
        }

        let status = '';
        switch (pin.color) {
          case 'green': status = 'home'; break;
          case 'yellow': status = 'not home'; break;
          case 'red': status = 'not interested'; break;
        }

        store.nodes.push({
          type: "survey",
          id: sha1(id+JSON.stringify(pin.survey)+pin.id),
          parent_id: id,
          created: pin.id,
          updated: pin.id,
          canvasser: store.canvasser,
          status: status,
          survey: pin.survey,
        });
      }

      delete store.pins;
    }
    return store;
  }

  _getNodesAsyncStorage = async () => {
    const { dbx, form } = this.state;
    try {
      const value = await storage.get(this.state.asyncStorageKey);
      if (value !== null) {
        this.setState({ myNodes: this._nodesFromJSON(value) });
      } else {
        // look on dropbox to see if this device has data that was cleared locally
        try {
          let data = await dbx.filesDownload({ path: form.folder_path+'/'+DeviceInfo.getUniqueID()+'.jtxt' });
          let myNodes = this._nodesFromJSON(data.fileBinary);
          this.setState({ myNodes });
          await this._saveNodes(myNodes, true);
        } catch (error) {}
      }

      await this.syncTurf(false);

    } catch (error) {
      console.warn(error);
    }

    this.updateMarkers();
  }

  updateMarkers() {
    this.markers = this.dedupeNodes(this.getNodesbyType("address"));
    this.updateIndex();
    this.forceUpdate();
  }

  updateIndex() {
    this.idx = {};
    this.idc = {};

    let merged = this.mergeNodes();

    for (let m in merged.nodes) {
      this.idx[merged.nodes[m].id] = merged.nodes[m];
      if (merged.nodes[m].parent_id) {
        if (!this.idc[merged.nodes[m].parent_id]) this.idc[merged.nodes[m].parent_id] = [];
        this.idc[merged.nodes[m].parent_id].unshift(merged.nodes[m])
      }
    }
  }

  _getCanvassSettings = async () => {
    try {
      const value = await storage.get(this.state.settingsStorageKey);
      if (value !== null) {
        this.setState({ canvassSettings: JSON.parse(value) });
      }
    } catch (e) {}
  }

  _setCanvassSettings = async (canvassSettings) => {
    const { form, dbx } = this.state;

    let sync = false;
    let rmshare = false;

    if (this.state.canvassSettings.show_only_my_turf !== canvassSettings.show_only_my_turf) sync = true;
    if (this.state.canvassSettings.share_progress !== canvassSettings.share_progress && canvassSettings.share_progress === false) rmshare = true;

    try {
      let str = JSON.stringify(canvassSettings);
      await storage.set(this.state.settingsStorageKey, str);
      this.setState({canvassSettings});
    } catch (e) {}

    if (sync) await this.syncTurf(false);

    if (rmshare) {
      try {
        let res = await dbx.filesListFolder({path: form.folder_path});
        for (let i in res.entries) {
          item = res.entries[i];
          if (item['.tag'] != 'folder') continue;
          if (item.path_display.match(/@/))
            await dbx.filesDelete({ path: item.path_display+'/exported.jtrf' });
        }
      } catch (e) {}
    }

  }

  syncTurf = async (flag) => {
    const { form, dbx } = this.state;

    this.setState({syncTurfRunning: true});
    let turfNodes = { nodes: [] };

    let files = [DeviceInfo.getUniqueID()];
    if (this.state.canvassSettings.show_only_my_turf !== true || flag === true) files.push('exported');

    // other jtxt files on this account are "my turf" too
    if (this.state.canvassSettings.show_only_my_turf !== true && flag === false) {
      let res = await dbx.filesListFolder({path: form.folder_path});
      for (let i in res.entries) {
        item = res.entries[i];
        if (item.path_display.match(/\.jtxt$/) && !item.path_display.match(DeviceInfo.getUniqueID())) {
          try {
            let data = await dbx.filesDownload({ path: item.path_display });
            turfNodes.nodes = turfNodes.nodes.concat((this._nodesFromJSON(data.fileBinary)).nodes);
          } catch (e) {}
        }
      }
    }

    for (let f in files) {
      let file = files[f];
      try {
        let data = await dbx.filesDownload({ path: form.folder_path+'/'+file+'.jtrf' });
        let obj = this._nodesFromJSON(data.fileBinary);
        turfNodes.nodes = turfNodes.nodes.concat(obj.nodes);
      } catch (e) {}
    }

    // don't setState inside a sync
    if (flag === false)
      this.setState({ turfNodes: turfNodes });

    this.updateMarkers();
    this.setState({syncTurfRunning: false});

    return turfNodes;
  }

  timeFormat(epoch) {
    let date = new Date(epoch*1000);
    return date.toLocaleDateString('en-us')+" "+date.toLocaleTimeString('en-us');
  }

  _saveNodes = async (myNodes, local) => {
    let { dbx } = this.state;
    if (local) myNodes.last_saved = this.getEpoch();
    this.setState({myNodes: myNodes});
    try {
      let str = JSON.stringify(myNodes);
      await storage.set(this.state.asyncStorageKey, str);
    } catch (error) {
      console.warn(error);
    }
  }

  _syncNodes = async (flag) => {
    let { dbx, form, user, myNodes } = this.state;
    let allNodes = {nodes: []};

    this.setState({syncRunning: true});

    let last_synced = myNodes.last_synced;
    myNodes.last_synced = this.getEpoch();

    try {
      let str = JSON.stringify(myNodes);
      await dbx.filesUpload({ path: form.folder_path+'/'+DeviceInfo.getUniqueID()+'.jtxt', contents: encoding.convert(tr(str), 'ISO-8859-1'), mode: {'.tag': 'overwrite'} });
      await this._saveNodes(myNodes, false);

      // extra sync stuff for the form owner
      if (user.dropbox.account_id == form.author_id) {
        // download all sub-folder .jtxt files
        let folders = [];
        let res = await dbx.filesListFolder({path: form.folder_path});
        for (let i in res.entries) {
          item = res.entries[i];
          // any devices logged in with the form creator are here
          if (item.path_display.match(/\.jtxt$/)) {
            let data = await dbx.filesDownload({ path: item.path_display });
            allNodes.nodes = allNodes.nodes.concat((this._nodesFromJSON(data.fileBinary)).nodes);
          }
          if (item['.tag'] != 'folder') continue;
          folders.push(item.path_display);
        }

        // TODO: do in paralell... let objs = await Promise.all(pro.map(p => p.catch(e => e)));

        // for each folder, download all .jtxt files
        for (let f in folders) {
          try {
            let res = await dbx.filesListFolder({path: folders[f]});
            for (let i in res.entries) {
              item = res.entries[i];
              if (item.path_display.match(/\.jtxt$/)) {
                let data = await dbx.filesDownload({ path: item.path_display });
                allNodes.nodes = allNodes.nodes.concat((this._nodesFromJSON(data.fileBinary)).nodes);
              }
            }
          } catch (e) {
            console.warn(e);
          }
        }

        allNodes.nodes = this.dedupeNodes(allNodes.nodes.concat((await this.syncTurf(true)).nodes));

        await dbx.filesUpload({ path: form.folder_path+'/exported.jtrf', contents: encoding.convert(tr(JSON.stringify(allNodes)), 'ISO-8859-1'), mode: {'.tag': 'overwrite'} });

        // copy exported.jtrf to all sub-folders if configured in settings
        if (this.state.canvassSettings.share_progress === true) {
          try {
            let res = await dbx.filesListFolder({path: form.folder_path});
            for (let i in res.entries) {
              item = res.entries[i];
              if (item['.tag'] != 'folder') continue;
              if (item.path_display.match(/@/))
                await dbx.filesUpload({ path: item.path_display+'/exported.jtrf', contents: encoding.convert(tr(JSON.stringify(allNodes)), 'ISO-8859-1'), mode: {'.tag': 'overwrite'} });
            }
          } catch (e) {
            console.warn(e);
          }
        }
      }

      await this.syncTurf(false);

      if (flag) Alert.alert('Success', 'Data sync successful!', [{text: 'OK'}], { cancelable: false });
    } catch (error) {
      if (flag) Alert.alert('Error', 'Unable to sync with the server.', [{text: 'OK'}], { cancelable: false });
      return;
    }

    this.setState({syncRunning: false, myNodes: myNodes});

    this.updateIndex();

    return allNodes;
  }

  mergeNodes() {
    let merged = {nodes: []};
    merged.nodes = this.dedupeNodes(this.state.myNodes.nodes.concat(this.state.turfNodes.nodes));

    return merged;
  }

  getNodeById(id) {
    if (this.idx[id]) return this.idx[id];
    return this.getNodeByIdStore(id, this.mergeNodes());
  }

  getNodeByIdStore(id, store) {
    for (let i in store.nodes)
      if (store.nodes[i].id === id)
        return store.nodes[i];
    return {};
  }

  updateNodeById = async (id, prop, value) => {
    let { myNodes } = this.state;
    let merged = this.mergeNodes();

    for (let i in merged.nodes) {
      let node = merged.nodes[i];
      if (node.id === id) {
        node[prop] = value;
        node.updated = this.getEpoch();

        this.idx[node.id] = node;

        // check if this ID is in myNodes
        for (let i in myNodes.nodes) {
          if (myNodes.nodes[i].id === id) {
            myNodes.nodes[i] = node;
            await this._saveNodes(myNodes, true);
            return;
          }
        }

        // it isn't in myNodes, so add it
        await this._addNode(node);
        return;
      }
    }
  }

  getNodesbyType(type) {
    let merged = this.mergeNodes();
    let nodes = [];
    for (let i in merged.nodes) {
      let node = merged.nodes[i];
      if (node.type === type)
        nodes.push(node);
    }
    return nodes;
  }

  getChildNodesByIdType(id, type) {
    let nodes = [];

    if (this.idc[id]) {
      for (let i in this.idc[id])
        if (this.idc[id][i].type === type)
          nodes.push(this.idc[id][i]);
      return nodes;
    }

    let merged = this.mergeNodes();
    for (let i in merged.nodes) {
      let node = merged.nodes[i];
      if (node.parent_id === id && node.type === type) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  dedupeNodes(nodes) {
    let idx = [];
    let deDupe = [];
    for (let i in nodes.sort(this.dynamicSort('updated')).reverse()) {
      let node = nodes[i];
      if (idx.indexOf(node.id) === -1) {
        idx.push(node.id);
        deDupe.push(node);
      }
    }
    return deDupe;
  }

  dynamicSort(property) {
    var sortOrder = 1;
    if(property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
  }

  getPinColor(node) {
    if (node.multi_unit) return "cyan";

    nodes = this.getChildNodesByIdType(node.id, "survey").sort(this.dynamicSort('updated'));

    // no interactions
    if (nodes.length === 0) return "#8b4513";

    switch (nodes[nodes.length-1].status) {
      case 'home': return "green";
      case 'not home': return "yellow";
      case 'not interested': return "red";
    }

    return "#8b4513";
  }

  doExport = async (refer) => {
    let { dbx, form } = this.state;

    refer.setState({exportRunning: true});
    let allNodes;
    let success = false;

    try {
      allNodes = await this._syncNodes(false);

      // convert to .csv file and upload
      let keys = Object.keys(form.questions);
      let csv = "Street,City,State,Zip,Unit,longitude,latitude,canvasser,datetime,status,"+keys.join(",")+"\n";

      for (let n in allNodes.nodes.sort(this.dynamicSort('updated'))) {
        let node = allNodes.nodes[n];
        if (node.type !== "survey") continue;

        let addr = this.getNodeByIdStore(node.parent_id, allNodes);

        // orphaned survey
        if (!addr.id) continue

        // unit
        if (addr.type === "unit") addr = this.getNodeByIdStore(addr.parent_id, allNodes);

        csv += (addr.address?addr.address.map((x) => '"'+(x?x:'')+'"').join(','):'')+
          ","+(addr.unit?addr.unit:'')+
          ","+(addr.latlng?addr.latlng.longitude:'')+
          ","+(addr.latlng?addr.latlng.latitude:'')+
          ","+node.canvasser+
          ","+this.timeFormat(node.updated)+
          ","+node.status;
        for (let key in keys) {
          let value = '';
          if (node.survey && node.survey[keys[key]]) value = node.survey[keys[key]];
          csv += ',"'+value+'"';
        }
        csv += "\n";
      }

      // csv file
      await dbx.filesUpload({ path: form.folder_path+'/'+form.name+'.csv', contents: encoding.convert(tr(csv), 'ISO-8859-1'), mode: {'.tag': 'overwrite'} });
      success = true;
    } catch(e) {
      console.warn(e);
    }

    refer.setState({ exportRunning: false }, refer.exportDone(success));
  }

  _canvassGuidelinesUrlHandler() {
    const url = "https://github.com/OurVoiceUSA/OVMobile/blob/master/docs/Canvassing-Guidelines.md";
    return Linking.openURL(url).catch(() => null);
  }

  render() {
    const { navigate } = this.props.navigation;
    const {
      showDisclosure, myPosition, myNodes, locationAccess, serviceError, form, user,
      fAddress, loading, dbx, region,
    } = this.state;

    if (showDisclosure === "true") {
      return (
        <ScrollView style={{flex: 1, backgroundColor: 'white'}}>
          <View style={styles.content}>
            <Text style={{margin: 15, fontSize: 18, color: 'dimgray'}}>
              Our Voice provides this canvassing tool for free for you to use for your own purposes. You will be talking
              to real people and asking real questions about policy positions that matter, and hopefully also collaborating
              with other canvassers. Together, we can crowd source the answers to how our country thinks outside of
              partisan politics.
            </Text>

            <View style={{margin: 15}}>
              <Text style={{fontSize: 18, color: 'dimgray'}}>
                By using this tool you acknowledge that you are acting on your own behalf, do not represent Our Voice USA
                or its affiliates, and have read our <Text style={{fontSize: 18, fontWeight: 'bold', color: 'blue'}} onPress={() => {this._canvassGuidelinesUrlHandler()}}>
                canvassing guidelines</Text>. Please be courteous to those you meet.
              </Text>
            </View>

                <View style={{margin: 5, flexDirection: 'row'}}>
                  <Icon.Button
                    name="check-circle"
                    backgroundColor="#d7d7d7"
                    color="#000000"
                    onPress={() => {
                      this.setState({ showDisclosure: "false"}); //Hide disclosure
                      this.SaveDisclosure(); //Save the disclosures acceptance
                    }}
                    {...iconStyles}>
                    I understand & agree to the guidelines
                  </Icon.Button>
                </View>

                <View style={{margin: 5, flexDirection: 'row'}}>
                  <Icon.Button
                    name="ban"
                    backgroundColor="#d7d7d7"
                    color="#000000"
                    onPress={() => {this.props.navigation.dispatch(NavigationActions.back())}}
                    {...iconStyles}>
                    I do not agree to this! Take me back!
                  </Icon.Button>
                </View>

          </View>
        </ScrollView>
      );
    }

    var nomap_content = [];

    if (locationAccess === false) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Access to your location is disabled.</Text>
          <Text>The map will not render unless you grant location access.</Text>
        </View>
      );
    } else if (serviceError === true) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Unable to load location services from your device.</Text>
        </View>
      );
    } else if (myPosition.latitude == null || myPosition.longitude == null) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Waiting on location data from your device...</Text>
          <ActivityIndicator />
        </View>
      );
    }

    // toggle pin horizon based on zoom level
    let markersInView = [];

    for (let m in this.markers) {
      let marker = this.markers[m];
      if (marker.latlng && marker.latlng.longitude !== null &&
        Math.hypot(region.longitude-marker.latlng.longitude, region.latitude-marker.latlng.latitude) < region.longitudeDelta/1.75)
        markersInView.push(marker);
    }

    return (
      <View style={styles.container}>

        {nomap_content.length &&
          <View>
            { nomap_content }
          </View>
        ||
        <MapView
          ref={component => this.map = component}
          initialRegion={{latitude: myPosition.latitude, longitude: myPosition.longitude, latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta}}
          onRegionChangeComplete={(region) => {
            this.setState({region});
          }}
          provider={PROVIDER_GOOGLE}
          style={styles.map}
          showsUserLocation={true}
          followsUserLocation={false}
          keyboardShouldPersistTaps={true}
          {...this.props}>
          {markersInView.map((marker) => {
            let status = this.getLatestSurvey(marker.id);
            let LastVisted = (status.LastVisted ? status.LastVisted : 'Never');
            return (
              <MapView.Marker
                key={marker.id}
                coordinate={marker.latlng}
                title={marker.address.join(", ")}
                draggable={this.state.canvassSettings.draggable_pins}
                onDragEnd={(e) => {
                  this.updateNodeById(marker.id, 'latlng', e.nativeEvent.coordinate);
                }}
                pinColor={this.getPinColor(marker)}>
                  <MapView.Callout onPress={() => {this.doMarkerPress(marker);}}>
                    <View style={{backgroundColor: '#FFFFFF', alignItems: 'center', padding: 5, width: 300, height: 65}}>
                      <Text style={{fontWeight: 'bold'}}>{marker.address.join(", ")}</Text>
                      <Text>{(marker.multi_unit ? 'Multi-unit address' : 'Last Visted: '+LastVisted)}</Text>
                    </View>
                  </MapView.Callout>
                </MapView.Marker>
          )})}
        </MapView>
        }

        <View style={{alignSelf: 'flex-end', alignItems: 'flex-end', marginRight: 5}}>
          <View style={{
              backgroundColor: '#FFFFFF', alignItems: 'flex-end', padding: 8,
              borderColor: '#000000', borderWidth: 2, borderRadius: 10, width: 100, height: 60,
            }}>
            {this.state.syncTurfRunning &&
            <ActivityIndicator size="large" />
            ||
            <View>
              <Text>{this.markers.length} pins</Text>
              <Text>{markersInView.length} in view</Text>
            </View>
            }
          </View>
        </View>

        <View style={styles.buttonContainer}>
          <TouchableOpacity style={styles.iconContainer}
            onPress={() => {this.showConfirmAddress();}}>
            <Icon
              name="map-marker"
              size={50}
              color="#8b4513"
              {...iconStyles} />
          </TouchableOpacity>

          {nomap_content.length == 0 &&
          <TouchableOpacity style={styles.iconContainer}
            onPress={() => this.map.animateToCoordinate(myPosition, 1000)}>
            <Icon
              name="location-arrow"
              size={50}
              color="#0084b4"
              {...iconStyles} />
          </TouchableOpacity>
          }

          {this.state.syncRunning &&
          <View style={styles.iconContainer}>
            <ActivityIndicator size="large" />
          </View>
          ||
          <View>
            <TouchableOpacity style={styles.iconContainer}
              onPress={() => {this._syncNodes(true)}}>
              <Icon
                name="refresh"
                size={50}
                color="#00a86b"
                {...iconStyles} />
            </TouchableOpacity>
          </View>
          }

          <TouchableOpacity style={styles.iconContainer}
            onPress={() => {navigate("CanvassingSettingsPage", {refer: this})}}>
            <Icon
              name="cog"
              size={50}
              color="#808080"
              {...iconStyles} />
          </TouchableOpacity>

        </View>

        <Modal
          open={this.state.isModalVisible}
          modalStyle={{width: 350, height: 400, backgroundColor: "transparent",
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}
          style={{alignItems: 'center'}}
          offset={0}
          overlayBackground={'rgba(0, 0, 0, 0.75)'}
          animationDuration={200}
          animationTension={40}
          modalDidOpen={() => undefined}
          modalDidClose={() => this.setState({isModalVisible: false})}
          closeOnTouchOutside={true}
          disableOnBackPress={false}>
          <View style={{flexDirection: 'column'}}>
            <View style={{width: 325, backgroundColor: 'white', marginTop: 5, borderRadius: 15, padding: 10, alignSelf: 'flex-start'}}>
              {loading &&
              <View>
                <Text style={{color: 'blue', fontWeight: 'bold', fontSize: 15}}>Loading Address</Text>
                <ActivityIndicator size="large" />
              </View>
              ||
              <View>
                <Text style={{color: 'blue', fontWeight: 'bold', fontSize: 15}}>Confirm the Address</Text>
                <Form
                 ref="formStreet"
                 type={formStreet}
                 onChange={this.onChange}
                 value={fAddress}
                />
                <Form
                 ref="formCity"
                 type={formCity}
                 onChange={this.onChange}
                 options={formOptRow}
                 value={fAddress}
                />
                <Form
                 ref="formState"
                 type={formState}
                 onChange={this.onChange}
                 options={formOptRow}
                 value={fAddress}
                />
                <TouchableHighlight style={styles.addButton} onPress={this.doConfirmAddress} underlayColor='#99d9f4'>
                  <Text style={styles.buttonText}>Add</Text>
                </TouchableHighlight>
              </View>
              }
            </View>
          </View>
        </Modal>

        <Modal
          open={this.state.isKnockMenuVisible}
          modalStyle={{width: 335, height: 350, backgroundColor: "transparent",
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}
          style={{alignItems: 'center'}}
          offset={0}
          overlayBackground={'rgba(0, 0, 0, 0.75)'}
          animationDuration={200}
          animationTension={40}
          modalDidOpen={() => undefined}
          modalDidClose={() => this.setState({isKnockMenuVisible: false})}
          closeOnTouchOutside={true}
          disableOnBackPress={false}>
          <KnockPage refer={this} funcs={this} />
        </Modal>

      </View>
    );
  }
}

const iconStyles = {
  justifyContent: 'center',
  borderRadius: 10,
  padding: 10,
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: '#FFF',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconContainer: {
    backgroundColor: '#ffffff', width: 65, height: 65, borderRadius: 65,
    borderWidth: 2, borderColor: '#000000',
    alignItems: 'center', justifyContent: 'center', margin: 2.5,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  bubble: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 20,
  },
  latlng: {
    width: 200,
    alignItems: 'stretch',
  },
  button: {
    width: 300,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
    backgroundColor: '#d7d7d7',
  },
  buttonText: {
    fontSize: 18,
    color: 'white',
    alignSelf: 'center'
  },
  addButton: {
    height: 36,
    backgroundColor: '#48BBEC',
    borderColor: '#48BBEC',
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 10,
    alignSelf: 'stretch',
    justifyContent: 'center'
  },
  buttonContainer: {
    flexDirection: 'row',
    marginVertical: 20,
    backgroundColor: 'transparent',
  },
});
