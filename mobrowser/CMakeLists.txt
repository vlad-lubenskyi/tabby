cmake_minimum_required(VERSION 3.21)

# Configures your project.
project(native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PROJECT_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR})
cmake_path(ABSOLUTE_PATH PROJECT_ROOT_DIR NORMALIZE)

# Imports the MōBrowser app configuration and setups the auxiliary targets, resources, etc.
# Important: Do not move this include above the project declaration.
include(${PROJECT_ROOT_DIR}/node_modules/@mobrowser/native/cmake/MoBrowser.cmake)

# The source files of your app.
set(APP_SOURCES src/native/main.cc)

# Defines the main target of the application.
add_library(mobrowser_lib STATIC ${APP_SOURCES} ${GENERATED_SOURCES})

mobrowser_configure_app_lib(mobrowser_lib)

# Add any additional include directories or configuration for mobrowser_lib here if needed
