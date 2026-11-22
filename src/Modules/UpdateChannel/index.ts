// This client's update channel: 'stable' (the default) or 'beta'.
//
// Chosen in the config window and kept in its own small file next to the
// profile, so it survives profile rewrites (adoption, recovery) but goes with a
// factory reset. Read by the self-updater at every check; see
// @showtrak/protocol/runtime update-channel for what each channel installs.
// Updates the server pushes over the LAN do not use it: the server chooses
// those builds (and only offers pre-release ones from its own beta channel).
import fs from 'fs';
import path from 'path';

import type { UpdateChannelState } from '@showtrak/protocol/client';
import { NormalizeUpdateChannel, type UpdateChannel } from '@showtrak/protocol/runtime';
import { Manager as AppDataManager } from '../AppData';
import { CreateLogger } from '../Logger';
import type { Unverified } from '../Utils';

const Logger = CreateLogger('UpdateChannel');

function ChannelPath(): string {
  return path.join(AppDataManager.GetProfileDirectory(), 'UpdateChannel.json');
}

export const Manager = {
  Get(): UpdateChannel {
    try {
      const Raw = JSON.parse(
        fs.readFileSync(ChannelPath(), 'utf8')
      ) as Unverified<UpdateChannelState> | null;
      return NormalizeUpdateChannel(Raw && Raw.Channel);
    } catch {
      return 'stable';
    }
  },

  Set(Value: unknown): UpdateChannel {
    const Channel = NormalizeUpdateChannel(Value);
    const File = ChannelPath();
    fs.mkdirSync(path.dirname(File), { recursive: true });
    const Temp = `${File}.tmp`;
    const State: UpdateChannelState = { Channel };
    fs.writeFileSync(Temp, JSON.stringify(State, null, 2));
    fs.renameSync(Temp, File);
    Logger.log(`Update channel set to ${Channel}`);
    return Channel;
  },

  /** Back to stable (factory reset). */
  Reset(): void {
    try {
      fs.rmSync(ChannelPath(), { force: true });
    } catch (Err) {
      Logger.warn('Failed to reset the update channel', Err);
    }
  },
};
