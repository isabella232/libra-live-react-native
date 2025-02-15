import React, { Component } from 'react';
import {
  Dimensions,
  StyleSheet,
  View,
  Platform,
  Text,
  TouchableOpacity,
  Animated,
} from 'react-native';
import PropTypes from 'prop-types';

import { AudioRecorder, AudioUtils } from 'react-native-audio';
import MapboxGL from '@mapbox/react-native-mapbox-gl';
import moment from 'moment';
import queryString from 'query-string';
import Config from 'react-native-config';

import { geocodeCityInput } from './services/geocoding';
import { sendAudioToLex } from './services/lex';

import MicrophoneIcon from './components/MicrophoneIcon';

const screenWidth = Dimensions.get('window').width;
const screenHeight = Dimensions.get('window').height;

const bandCombinations = {
  natural: 'B4,B3,B2',
  vegetationHealth: 'B5,B6,B2',
  landWater: 'B5,B6,B4',
};

const bandCombinationLabels = {
  natural: 'Natural Color',
  vegetationHealth: 'Vegetation Health',
  landWater: 'Land/Water Analysis',
};

const colorWhite = '#fff';
const transparentBlack = 'rgba(0, 0, 0, 0.7)';
const micInactiveShadow = '#4AE2D6';
const micActiveShadow = '#CD50E7';

const inactiveShadowRadius = 10;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
    width: '100%',
  },
  header: {
    backgroundColor: transparentBlack,
    padding: 14,
    position: 'absolute',
    top: 0,
    left: 0,
    width: screenWidth,
  },
  headerText: {
    color: colorWhite,
    fontSize: 14,
  },
  microphoneButton: {
    position: 'absolute',
    bottom: 40,
    right: screenWidth / 2 - 40,
  },
  buttonContainer: {
    backgroundColor: colorWhite,
    borderRadius: 64,
    width: 80,
    height: 80,
    alignItems: 'center',
    elevation: 1,
    padding: 1,
    paddingTop: 10,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
  },
  errorView: {
    backgroundColor: transparentBlack,
    position: 'absolute',
    top: 0,
    left: 0,
    width: screenWidth,
    height: screenHeight,
    padding: 50,
    paddingTop: 80,
  },
  errorText: {
    color: colorWhite,
    fontSize: 26,
  },
});

export default class MapScreen extends Component {
  constructor(props) {
    super(props);

    const { navigation } = this.props;
    const centerCoords = navigation.getParam('centerCoords', [
      -77.0368707,
      38.9071923,
    ]);

    // default params for demo
    // TODO: consider getting user location
    const tileQueryParamsUI = {
      bandCombination: bandCombinationLabels.natural,
      city: 'Washington D.C.',
    };

    this.state = {
      centerCoords,
      nightlights: false,
      detectRoads: false,
      tileQueryParamsUI,
      tileQueryString: null,
      isAuthorized: false,
      isMapLoaded: false,
      isRecording: false,
      animatedShadowRadius: new Animated.Value(inactiveShadowRadius),
      errorMessage: null,
      useHighResImagery: false,
    };
  }

  componentDidMount() {
    this.convertLexSlotsToQueryParams();

    AudioRecorder.requestAuthorization().then((isAuthorized) => {
      this.setState({ isAuthorized });
    });

    this.prepareRecordingAnimation();
  }

  onDidFinishRenderingMapFully() {
    if (this.mapRef.props.styleURL === Config.MAPBOX_STYLE_URL) {
      this.setState({
        isMapLoaded: true,
      });
    }
  }

  onWillStartLoadingMap() {
    this.setState({
      isMapLoaded: false,
    });
  }

  setErrorMessage(message) {
    this.setState({
      errorMessage: message,
    });
  }

  onAudioRecordingFinished = async (data) => {
    // Android callback comes in the form of a promise instead.
    if (Platform.OS === 'ios') {
      this.finishRecording(data.audioFileURL);
    }

    const { isRecording } = this.state;

    if (isRecording) {
      return;
    }

    const errorMessage = 'Sorry, we didn\'t understand that. Please try again';

    if (!data.base64) {
      this.setErrorMessage(errorMessage);
      return;
    }

    let feature;
    let lexResponse;

    try {
      lexResponse = await sendAudioToLex(data);

      console.log('lexResponse', lexResponse);

      if (lexResponse.slots) {
        if (!lexResponse.slots.City) {
          this.setErrorMessage('Sorry, we couldn\'t understand that city. Please try again');
          return;
        }

        const geoResponse = await geocodeCityInput(lexResponse.slots);
        console.log('geoResponse', geoResponse);

        [feature] = geoResponse.body.features;

        if (!feature || !feature.geometry) {
          this.setErrorMessage(`${lexResponse.slots.City} not found. Please try again`);
          return;
        }

        this.setState({ tileQueryString: null }, () => {
          this.updateMap(feature, lexResponse.slots);
        });
      } else {
        this.setErrorMessage(lexResponse.message);
      }
    } catch (err) {
      if (lexResponse && lexResponse.dialogState === 'ElicitIntent') {
        this.setErrorMessage(lexResponse.message);
      } else {
        this.setErrorMessage(errorMessage);
      }
    }
  }

  convertLexSlotsToQueryParams(lexSlotValues = {}) {
    const { tileQueryParamsUI } = this.state;
    const tileQueryParams = {};

    const useHighResImagery = lexSlotValues.HighResolutionImagery
      && lexSlotValues.HighResolutionImagery !== null;

    const detectRoads = lexSlotValues.DetectRoads
      && lexSlotValues.DetectRoads !== null;

    const nightlights = lexSlotValues.NightLights
      && lexSlotValues.NightLights !== null;

    const startDate = '1960-01-01';
    const endDate = lexSlotValues.Date || moment().format('YYYY-MM-DD');
    tileQueryParams.datetime = `${startDate}/${endDate}`;

    if (lexSlotValues.CloudPercentage) {
      tileQueryParams['eo:coverage'] = lexSlotValues.CloudPercentage;
    }

    let bandType = 'natural';
    if (lexSlotValues.VegetationHealth) {
      bandType = 'vegetationHealth';
    } else if (lexSlotValues.LandWaterAnalysis) {
      bandType = 'landWater';
    }
    tileQueryParams['eo:bands'] = bandCombinations[bandType];

    this.setState({
      nightlights,
      detectRoads,
      tileQueryParamsUI: Object.assign(tileQueryParamsUI, {
        bandCombination: bandType,
        date: endDate,
        cloudPercentage: lexSlotValues.CloudPercentage || 0,
      }),
      tileQueryString: queryString.stringify(tileQueryParams),
      useHighResImagery,
    });
  }

  finishRecording(filePath) {
    this.setState({
      isRecording: false,
    });
    console.log(`Finished recording at path: ${filePath}`);
  }

  prepareRecorder() {
    const audioPath = `${AudioUtils.DocumentDirectoryPath}/voice-recording.lpcm`;
    AudioRecorder.prepareRecordingAtPath(audioPath, {
      SampleRate: 8000,
      Channels: 1,
      AudioQuality: 'High',
      AudioEncoding: 'lpcm',
      IncludeBase64: true,
    });

    AudioRecorder.onFinished = this.onAudioRecordingFinished;
  }

  prepareRecordingAnimation() {
    const { animatedShadowRadius } = this.state;

    const animatedRadiusValues = [5, 10, 15, 8, 12, 18, 10, 7];
    const animations = animatedRadiusValues.map(radiusValue => Animated.timing(
      animatedShadowRadius,
      {
        toValue: radiusValue,
        duration: 200,
        useNativeDriver: true,
      },
    ));

    this.recordingAnimation = Animated.loop(Animated.sequence(animations));
  }

  updateMap(feature, lexSlotValues) {
    const { tileQueryParamsUI } = this.state;
    this.convertLexSlotsToQueryParams(lexSlotValues);

    const city = lexSlotValues.City;
    const fallbackCityName = city.charAt(0).toUpperCase() + city.slice(1);

    this.setState({
      centerCoords: feature.geometry.coordinates,
      tileQueryParamsUI: Object.assign(tileQueryParamsUI, {
        city: feature.text || feature.place_name || fallbackCityName,
      }),
    });
  }

  async startRecording() {
    const { isAuthorized } = this.state;
    if (!isAuthorized) {
      return;
    }

    this.prepareRecorder();
    this.recordingAnimation.start();

    this.setState({
      isRecording: true,
      errorMessage: null,
    });

    try {
      await AudioRecorder.startRecording();
    } catch (error) {
      console.error(error);
      this.setErrorMessage('There was a problem recording audio. Please try again.');
    }
  }

  async stopRecording() {
    this.stopRecordingAnimation();

    try {
      const filePath = await AudioRecorder.stopRecording();

      if (Platform.OS === 'android') {
        this.finishRecording(filePath);
      }
    } catch (error) {
      console.error(error);
      this.setErrorMessage('There was a problem recording audio. Please try again.');
    }
  }

  stopRecordingAnimation() {
    const { animatedShadowRadius } = this.state;

    const resetButtonShadow = Animated.timing(
      animatedShadowRadius,
      {
        toValue: inactiveShadowRadius,
        duration: 200,
        useNativeDriver: true,
      },
    );

    this.recordingAnimation.stop();
    this.recordingAnimation.reset();
    resetButtonShadow.start();
  }

  renderRasterLayer() {
    const {
      nightlights,
      detectRoads,
      isMapLoaded,
      tileQueryString,
      useHighResImagery,
    } = this.state;

    if (useHighResImagery || nightlights || !tileQueryString) {
      return null;
    }

    const rasterLayerProps = {
      belowLayerID: null,
    };
    if (isMapLoaded && !detectRoads) {
      rasterLayerProps.belowLayerID = 'waterway-label';
    }
    let tilerURL;

    if (detectRoads) {
      tilerURL = Config.SKYNET_TILER_URL;
    } else {
      tilerURL = `${Config.TILER_URL}?${tileQueryString}`;
    }

    return (
      <MapboxGL.RasterSource
        id="sat"
        tileSize={256}
        url={tilerURL}
      >
        <MapboxGL.RasterLayer
          id="satLayer"
          sourceID="sat"
          {...rasterLayerProps}
        />
      </MapboxGL.RasterSource>
    );
  }

  render() {
    const {
      animatedShadowRadius,
      centerCoords,
      nightlights,
      detectRoads,
      errorMessage,
      isRecording,
      tileQueryParamsUI,
      useHighResImagery,
    } = this.state;

    const { bandCombination, date, city } = tileQueryParamsUI;

    const bands = bandCombinationLabels[bandCombination];

    let zoomLevel = 10;
    if (useHighResImagery || detectRoads) {
      zoomLevel = 16;
    } else if (nightlights) {
      zoomLevel = 8;
    }

    let styleURL = Config.MAPBOX_STYLE_URL;
    if (useHighResImagery || detectRoads) {
      styleURL = MapboxGL.StyleURL.Satellite;
    } else if (nightlights) {
      styleURL = Config.NIGHTLIGHTS_STYLE_URL;
    }

    return (
      <View style={styles.container}>
        { centerCoords && (
          <MapboxGL.MapView
            centerCoordinate={centerCoords}
            minZoomLevel={8}
            onDidFinishRenderingMapFully={() => this.onDidFinishRenderingMapFully()}
            onWillStartLoadingMap={() => this.onWillStartLoadingMap()}
            ref={(ref) => { this.mapRef = ref; }}
            style={styles.map}
            styleURL={styleURL}
            zoomLevel={zoomLevel}
          >
            {this.renderRasterLayer()}
          </MapboxGL.MapView>
        ) }
        {
          errorMessage && (
            <View style={[styles.errorView]}>
              <Text style={[styles.errorText]}>{errorMessage}</Text>
            </View>
          )
        }
        {
          /* the nbsp silliness below is to appease the linter and still look right. */
          !errorMessage && (
            <View style={[styles.header]}>
              <Text style={[styles.headerText]}>
                {city}
                &nbsp;
                |
                &nbsp;
                {bands}
                &nbsp;
                |
                &nbsp;
                {date}
              </Text>
            </View>
          )
        }
        <TouchableOpacity
          activeOpacity={1}
          style={[styles.microphoneButton]}
          onPressIn={() => {
            this.startRecording();
          }}
          onPressOut={() => {
            this.stopRecording();
          }}
        >
          <Animated.View
            style={[styles.buttonContainer, {
              shadowColor: isRecording ? micActiveShadow : micInactiveShadow,
              shadowRadius: animatedShadowRadius,
            }]}
          >
            <MicrophoneIcon width={38} height={65} />
          </Animated.View>
        </TouchableOpacity>
      </View>
    );
  }
}

MapScreen.propTypes = {
  navigation: PropTypes.shape({
    getParam: PropTypes.func.isRequired,
  }).isRequired,
};
