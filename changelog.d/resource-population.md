## Features

- The composer now populates app call resources while simulating for fees. Accounts, apps, assets, boxes, app locals and asset holdings that app calls access without referencing are added to the group's reference arrays. Pass `populateAppCallResources: false` to the `Composer` constructor to disable it.
