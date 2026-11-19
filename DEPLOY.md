# GitHub Pages package

This folder is a static build of The Quiet Home. It contains no Node server or build-time dependencies.

## Publish

1. If online play is wanted, edit src/firebase-config.js in the project source and add the Firebase Web App client values: apiKey, authDomain, databaseURL, projectId, and appId. These are public client settings; never add a service-account/private key. With blank settings the game still works offline.
2. Run npm run build:pages again after changing the config.
3. Upload the contents of this folder (not the folder wrapper) to the repository root or to a GitHub Pages /docs folder. Relative URLs support repository subpaths such as https://USER.github.io/REPOSITORY/.
4. Enable Pages for the branch/folder in the repository settings.

Firebase JS modules are loaded from Firebase's HTTPS CDN only when Firebase is configured.
