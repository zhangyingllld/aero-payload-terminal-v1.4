import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import hilog from '@ohos.hilog';
import type { BusinessError } from '@ohos.base';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        hilog.error(0x0001, 'PayloadTerminal', 'LOAD_FAILED %{public}s', JSON.stringify(error));
      } else {
        hilog.info(0x0001, 'PayloadTerminal', 'PAGE_READY');
      }
    });
    windowStage.getMainWindow().then((mainWindow: window.Window) => {
      mainWindow.setWindowKeepScreenOn(true).catch((error: BusinessError) => {
        hilog.warn(0x0001, 'PayloadTerminal', 'KEEP_SCREEN_FAILED %{public}s', error.message);
      });
      mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#EDF3F6', statusBarContentColor: '#122B40',
        navigationBarColor: '#EDF3F6', navigationBarContentColor: '#122B40'
      }).catch((error: BusinessError) => {
        hilog.warn(0x0001, 'PayloadTerminal', 'SYSTEM_BAR_FAILED %{public}s', error.message);
      });
    }).catch((error: BusinessError) => {
      hilog.error(0x0001, 'PayloadTerminal', 'WINDOW_FAILED %{public}s', error.message);
    });
  }
}
