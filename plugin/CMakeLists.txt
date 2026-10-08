cmake_minimum_required(VERSION 3.22)
project(ThreeXOSO VERSION 1.0.0)
set(CMAKE_CXX_STANDARD 17)
include(FetchContent)
FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.8 GIT_SHALLOW ON)
FetchContent_Declare(clap-juce-extensions GIT_REPOSITORY https://github.com/free-audio/clap-juce-extensions.git GIT_TAG main GIT_SHALLOW ON)
FetchContent_MakeAvailable(JUCE clap-juce-extensions)

juce_add_plugin(ThreeXOSO
  COMPANY_NAME "Circuit Drift Labs"
  PLUGIN_MANUFACTURER_CODE Cdlb PLUGIN_CODE Xoso
  FORMATS VST3 Standalone
  PRODUCT_NAME "3xOSO"
  IS_SYNTH TRUE NEEDS_MIDI_INPUT TRUE EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  VST3_CATEGORIES Instrument Synth
  COPY_PLUGIN_AFTER_BUILD FALSE)

clap_juce_extensions_plugin(TARGET ThreeXOSO
  CLAP_ID "labs.circuitdrift.3xoso" CLAP_FEATURES instrument synthesizer stereo)

target_sources(ThreeXOSO PRIVATE Source/Plugin.cpp)
target_compile_definitions(ThreeXOSO PUBLIC
  JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0 JUCE_DISPLAY_SPLASH_SCREEN=0)
target_link_libraries(ThreeXOSO PRIVATE juce::juce_audio_utils juce::juce_audio_plugin_client
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_lto_flags)
