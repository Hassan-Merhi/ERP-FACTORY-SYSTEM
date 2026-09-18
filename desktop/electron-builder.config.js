/**
 * electron-builder configuration for HMD ERP + FACTORY SYSTEM
 * Microsoft Store MSIX / APPX package
 */

module.exports = {
  appId: "com.hmdinternationalgroup.hmderpfactorysystem",
  productName: "HMD ERP + FACTORY SYSTEM",
  copyright: "Copyright © 2026 HMD International Group",

  directories: {
    output: "dist",
    buildResources: "build",
  },

  files: [
    "main.js",
    "preload.js",
    "offline.html",
    "icons/**/*",
    "package.json",
    "!node_modules/**/*",
    "!dist/**/*",
    "!scripts/**/*",
  ],

  extraMetadata: {
    version: process.env.APP_VERSION || require("./package.json").version,
  },

  win: {
    target: [{ target: "appx", arch: ["x64"] }],
    icon: "icons/icon.ico",

    // electron-builder 25 moved the signtool settings off the win root and
    // under signtoolOptions. Left at the root they are not merely ignored —
    // schema validation rejects the whole win block.
    signtoolOptions: {
      publisherName: "Hassan Dakik",
      signingHashAlgorithms: ["sha256"],
    },
  },

  appx: {
    identityName: "HassanDakik.HMDERPFACTORYSYSTEM",
    publisher: "CN=3D500DA2-F04D-4D3C-A10F-89F31D7C393E",
    publisherDisplayName: "Hassan Dakik",

    applicationId: "HMDERPFactorySystem",
    displayName: "HMD ERP + FACTORY SYSTEM",
    backgroundColor: "#0f172a",
    showNameOnTiles: true,
    languages: ["en-US"],
    minVersion: "10.0.17763.0",
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "icons/icon.ico",
    uninstallerIcon: "icons/icon.ico",
    installerHeaderIcon: "icons/icon.ico",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "HMD ERP + FACTORY SYSTEM",
  },
};
