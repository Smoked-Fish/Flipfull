'use strict';
define(function(require) {
  require('modules/apps_cache');

  const HIDDEN_ROLES = ['system', 'invisible', 'homescreen', 'input',
    'theme', 'addon', 'langpack'];

  return function launchableApps() {
    return AppsCache.apps().then(apps => {
      const list = [];
      apps.forEach(app => {
        const manifest = app.manifest || app.updateManifest;
        const url = app.manifestUrl || app.manifestURL;
        if (!manifest || !url || HIDDEN_ROLES.includes(manifest.role) ||
            app.status === Constants.AppsStatus.DISABLED) {
          return;
        }
        const helper = new ManifestHelper(manifest);
        list.push({ url, name: helper.short_name || helper.name || url });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      return list;
    });
  };
});
