import type { AudioDirection, AudioEndpoint } from '@showtrak/protocol';
import type { Result } from '../../types/client';
import { CreatePowerShellHost } from '../ProcessMonitor/powershell-host';
import {
  NormalizeVolume,
  PositiveInteger,
  RunCommand,
  WASAPI_CAPABILITIES,
  type AudioLevelChange,
  type AudioSample,
} from './shared';

// Windows reads audio through Core Audio — IMMDeviceEnumerator for the endpoints
// and defaults, IPropertyStore for names and the engine format, and
// IAudioEndpointVolume for the level and mute. None of that is reachable from
// PowerShell cmdlets (Win32_SoundDevice knows nothing about endpoints, defaults or
// levels), so a small C# shim is compiled into the PowerShell session with
// Add-Type and called from there.
//
// Compiling costs a second or two, once: the shim lives in a persistent host of
// its own, and every later sample is a single method call. It is a separate host
// from the running-applications sampler's because a host serves one request at a
// time, and the two samplers run on unrelated timers.
//
// UNVERIFIED ON REAL WINDOWS at the time of writing: covered by unit tests
// against a mocked host. The shim is deliberately C# 5 — Windows PowerShell 5.1
// compiles Add-Type sources with the .NET Framework compiler, which rejects
// string interpolation, expression-bodied members and `out var`.

/**
 * The shim. Every COM method is declared `void` WITHOUT [PreserveSig] so a failed
 * HRESULT surfaces as an exception; declaring them as returning `int` (as many
 * samples do) silently changes the native signature. Interfaces only need their
 * vtable declared up to the last method called, but in order.
 */
export const WINDOWS_AUDIO_SHIM = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace ShowTrak
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
        public PropertyKey(Guid f, int p) { fmtid = f; pid = p; }
    }

    // PROPVARIANT, laid out so it works on both 32- and 64-bit: the type tag at 0,
    // then two pointer-sized slots. A string or blob-size lives in the first slot,
    // a blob's data pointer in the second.
    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant
    {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr p1;
        public IntPtr p2;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out int count);
        void GetAt(int index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        void OpenPropertyStore(int access, out IPropertyStore store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IntPtr notify);
        void UnregisterControlChangeNotify(IntPtr notify);
        void GetChannelCount(out uint count);
        void SetMasterVolumeLevel(float levelDB, ref Guid context);
        void SetMasterVolumeLevelScalar(float level, ref Guid context);
        void GetMasterVolumeLevel(out float levelDB);
        void GetMasterVolumeLevelScalar(out float level);
        void SetChannelVolumeLevel(uint channel, float levelDB, ref Guid context);
        void SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        void GetChannelVolumeLevel(uint channel, out float levelDB);
        void GetChannelVolumeLevelScalar(uint channel, out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    public static class AudioEndpoints
    {
        const int eRender = 0;
        const int eCapture = 1;
        const int eConsole = 0;
        const int DEVICE_STATE_ACTIVE = 1;
        const int CLSCTX_ALL = 23;
        const ushort VT_LPWSTR = 31;
        const ushort VT_BLOB = 65;

        static readonly Guid VolumeIID = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static readonly PropertyKey FriendlyName = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
        static readonly PropertyKey Manufacturer = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 13);
        static readonly PropertyKey DeviceFormat = new PropertyKey(new Guid("f19f064d-082c-4e27-bc73-6882a1bb8e4c"), 0);

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant pv);

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        }

        static string ReadString(IPropertyStore store, PropertyKey key)
        {
            PropVariant pv;
            try { store.GetValue(ref key, out pv); } catch { return null; }
            try
            {
                if (pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero) return Marshal.PtrToStringUni(pv.p1);
                return null;
            }
            finally { PropVariantClear(ref pv); }
        }

        // WAVEFORMATEX: nChannels is the ushort at offset 2, nSamplesPerSec the uint at 4.
        static void ReadFormat(IPropertyStore store, out int channels, out int sampleRate)
        {
            channels = 0;
            sampleRate = 0;
            PropertyKey key = DeviceFormat;
            PropVariant pv;
            try { store.GetValue(ref key, out pv); } catch { return; }
            try
            {
                long size = pv.p1.ToInt64() & 0xFFFFFFFFL;
                if (pv.vt != VT_BLOB || size < 8 || pv.p2 == IntPtr.Zero) return;
                channels = (ushort)Marshal.ReadInt16(pv.p2, 2);
                sampleRate = Marshal.ReadInt32(pv.p2, 4);
            }
            finally { PropVariantClear(ref pv); }
        }

        static IAudioEndpointVolume Volume(IMMDevice device)
        {
            Guid iid = VolumeIID;
            object instance;
            device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out instance);
            return (IAudioEndpointVolume)instance;
        }

        static string Json(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder("\\"");
            foreach (char c in value)
            {
                if (c == '\\\\') sb.Append("\\\\\\\\");
                else if (c == '"') sb.Append("\\\\\\"");
                else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static string DefaultId(IMMDeviceEnumerator enumerator, int flow)
        {
            try
            {
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(flow, eConsole, out device);
                string id;
                device.GetId(out id);
                return id;
            }
            catch { return null; }
        }

        public static string Query()
        {
            IMMDeviceEnumerator enumerator = Enumerator();
            List<string> rows = new List<string>();
            int[] flows = new int[] { eRender, eCapture };
            foreach (int flow in flows)
            {
                string defaultId = DefaultId(enumerator, flow);
                IMMDeviceCollection collection;
                enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out collection);
                int count;
                collection.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IMMDevice device;
                    collection.Item(i, out device);
                    string id;
                    device.GetId(out id);
                    IPropertyStore store;
                    device.OpenPropertyStore(0, out store);
                    string name = ReadString(store, FriendlyName);
                    string manufacturer = ReadString(store, Manufacturer);
                    int channels;
                    int sampleRate;
                    ReadFormat(store, out channels, out sampleRate);
                    string volume = "null";
                    string muted = "null";
                    try
                    {
                        IAudioEndpointVolume control = Volume(device);
                        float scalar;
                        control.GetMasterVolumeLevelScalar(out scalar);
                        volume = Math.Round(scalar * 100.0).ToString(System.Globalization.CultureInfo.InvariantCulture);
                        bool isMuted;
                        control.GetMute(out isMuted);
                        muted = isMuted ? "true" : "false";
                        if (channels == 0)
                        {
                            uint controlChannels;
                            control.GetChannelCount(out controlChannels);
                            channels = (int)controlChannels;
                        }
                    }
                    catch { }
                    rows.Add("{\\"Id\\":" + Json(id)
                        + ",\\"Flow\\":" + (flow == eRender ? "\\"output\\"" : "\\"input\\"")
                        + ",\\"Name\\":" + Json(name)
                        + ",\\"Manufacturer\\":" + Json(manufacturer)
                        + ",\\"Channels\\":" + channels.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ",\\"SampleRate\\":" + sampleRate.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ",\\"IsDefault\\":" + (id == defaultId ? "true" : "false")
                        + ",\\"Volume\\":" + volume
                        + ",\\"Muted\\":" + muted + "}");
                }
            }
            return "[" + String.Join(",", rows.ToArray()) + "]";
        }

        // volume: 0-100, or negative to leave it. mute: 0/1, or negative to leave it.
        public static string SetLevel(string id, int volume, int mute)
        {
            IMMDevice device;
            Enumerator().GetDevice(id, out device);
            IAudioEndpointVolume control = Volume(device);
            Guid context = Guid.Empty;
            if (volume >= 0) control.SetMasterVolumeLevelScalar(Math.Min(100, volume) / 100.0f, ref context);
            if (mute >= 0) control.SetMute(mute == 1, ref context);
            return "ok";
        }
    }
}
`;

const SHIM_BASE64 = Buffer.from(WINDOWS_AUDIO_SHIM, 'utf8').toString('base64');

/**
 * Compile the shim into the session unless it is already there. The source rides
 * as base64 so the whole statement stays on one line (the host evaluates one line
 * per request) and so no quoting rules apply to it.
 */
const ENSURE_SHIM =
  "if (-not ('ShowTrak.AudioEndpoints' -as [type])) { " +
  `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${SHIM_BASE64}'))) ` +
  '}';

export const WINDOWS_QUERY_SCRIPT = `${ENSURE_SHIM}; [ShowTrak.AudioEndpoints]::Query()`;

/**
 * The statement that applies a change. The endpoint id is passed as base64 for the
 * same reason as the shim: PowerShell treats several Unicode quotation marks as
 * string delimiters, so escaping one ASCII quote is not enough to keep an id from
 * ending its literal early.
 */
export function BuildWindowsLevelScript(EndpointID: string, Change: AudioLevelChange): string {
  const Id = Buffer.from(EndpointID, 'utf8').toString('base64');
  const Volume =
    typeof Change.Volume === 'number' ? Math.max(0, Math.min(100, Math.round(Change.Volume))) : -1;
  const Mute = typeof Change.Muted === 'boolean' ? (Change.Muted ? 1 : 0) : -1;
  return (
    `${ENSURE_SHIM}; [ShowTrak.AudioEndpoints]::SetLevel(` +
    `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Id}')), ${Volume}, ${Mute})`
  );
}

/** Endpoint ids carry a backend prefix so they can never collide across platforms. */
const ID_PREFIX = 'wasapi:';

export function ToWindowsDeviceID(EndpointID: string): string | null {
  return EndpointID.startsWith(ID_PREFIX) ? EndpointID.slice(ID_PREFIX.length) : null;
}

/** Parse the shim's JSON into endpoints. */
export function ParseWindowsAudio(Text: string): AudioEndpoint[] {
  // The shim writes the list as one line. Anything else (a compile error, a
  // warning) must fail the sample: reading it as an empty list would report
  // every critical device as missing.
  const Line = String(Text || '')
    .split(/\r?\n/)
    .map((Entry) => Entry.trim())
    .find((Entry) => Entry.startsWith('[') && Entry.endsWith(']'));
  if (!Line) throw new Error('Audio query returned no device list');
  const Rows: unknown = JSON.parse(Line);
  if (!Array.isArray(Rows)) throw new Error('Audio query returned no device list');
  const Endpoints: AudioEndpoint[] = [];
  for (const Raw of Rows) {
    if (!Raw || typeof Raw !== 'object') continue;
    const Row = Raw as Record<string, unknown>;
    const Id = typeof Row.Id === 'string' ? Row.Id.trim() : '';
    if (!Id) continue;
    const Direction: AudioDirection = Row.Flow === 'input' ? 'input' : 'output';
    Endpoints.push({
      EndpointID: `${ID_PREFIX}${Id}`,
      Direction,
      Name:
        (typeof Row.Name === 'string' && Row.Name.trim()) ||
        (Direction === 'input' ? 'Audio Input' : 'Audio Output'),
      Manufacturer:
        typeof Row.Manufacturer === 'string' && Row.Manufacturer.trim()
          ? Row.Manufacturer.trim()
          : null,
      Transport: null,
      Channels: PositiveInteger(Row.Channels),
      SampleRate: PositiveInteger(Row.SampleRate),
      IsDefault: Row.IsDefault === true,
      Volume: NormalizeVolume(Row.Volume),
      Muted: typeof Row.Muted === 'boolean' ? Row.Muted : null,
    });
  }
  return Endpoints;
}

// The first call compiles the shim; every later one is a method call.
const HOST_TIMEOUT_MS = 20000;

const Host = CreatePowerShellHost('AudioPowerShellHost');

/** Run in the persistent host, falling back to a one-shot powershell.exe. */
async function RunPowerShell(Script: string): Promise<Result<string>> {
  const [HostError, Output] = await Host.Run(Script, HOST_TIMEOUT_MS);
  if (!HostError && Output !== null) return [null, Output];
  return RunCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${Script}`,
  ]);
}

export async function CollectWindowsAudio(): Promise<Result<AudioSample>> {
  const [Error_, Output] = await RunPowerShell(WINDOWS_QUERY_SCRIPT);
  if (Error_ || Output === null) return [Error_ || new Error('No output'), null];
  try {
    return [
      null,
      {
        Backend: 'wasapi',
        Endpoints: ParseWindowsAudio(Output),
        Capabilities: WASAPI_CAPABILITIES,
      },
    ];
  } catch (error) {
    return [error, null];
  }
}

export async function SetWindowsAudioLevel(
  Endpoint: AudioEndpoint,
  Change: AudioLevelChange
): Promise<Result<true>> {
  const DeviceID = ToWindowsDeviceID(Endpoint.EndpointID);
  if (!DeviceID) return [new Error('Not a Windows audio endpoint'), null];
  const [Error_] = await RunPowerShell(BuildWindowsLevelScript(DeviceID, Change));
  if (Error_) return [Error_, null];
  return [null, true];
}

export function DisposeWindowsAudio(): void {
  Host.Dispose();
}

export const _internal = { Host, HOST_TIMEOUT_MS };
