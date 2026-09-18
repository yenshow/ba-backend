using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using static QuickNV.HikvisionISUPSDK.Defines;
using static QuickNV.HikvisionISUPSDK.Methods;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);

var listenIp = ReadEnv("ISUP_LISTEN_IP", "0.0.0.0");
var listenPort = ushort.TryParse(Environment.GetEnvironmentVariable("ISUP_LISTEN_PORT"), out var parsedPort)
    ? parsedPort
    : (ushort)7660;
var alarmPort = ushort.TryParse(Environment.GetEnvironmentVariable("ISUP_ALARM_PORT"), out var parsedAlarmPort)
    ? parsedAlarmPort
    : (ushort)7663;
var advertiseIp = ReadEnv("ISUP_ADVERTISE_IP", "192.168.2.8");
var expectedDeviceId = ReadEnv("ISUP_DEVICE_ID", "");
var isupKey = Environment.GetEnvironmentVariable("ISUP_KEY")?.Trim() ?? "";
var alarmProtocol = ReadEnv("ISUP_ALARM_PROTOCOL", "mqtt").Equals("tcp", StringComparison.OrdinalIgnoreCase)
    ? IsupAlarmNative.ProtocolTcp
    : IsupAlarmNative.ProtocolMqtt;

if (string.IsNullOrWhiteSpace(isupKey))
{
    WriteEvent(new
    {
        type = "error",
        message = "請設定環境變數 ISUP_KEY，必須與 PDA「ISUP5 Info -> 密钥」完全一致",
    });
    return 1;
}

try
{
    PrepareNativePath();
    INIT_NATIVE_DIR();
    if (!IsupAlarmNative.Init())
    {
        WriteEvent(new
        {
            type = "error",
            message = "NET_EALARM_Init 失敗",
            errorCode = IsupAlarmNative.GetLastError(),
        });
        return 1;
    }
    Invoke(NET_ECMS_Init());
}
catch (Exception exception)
{
    WriteEvent(new
    {
        type = "error",
        message = "ISUP SDK Init 失敗，請確認 HCISUPCMS.dll / HCISUPAlarm.dll 已在輸出目錄",
        detail = exception.Message,
    });
    return 1;
}

IsupAlarmNative.EHomeMsgCallBack alarmCallback = HandleAlarm;
GC.KeepAlive(alarmCallback);
var alarmListen = -1;
try
{
    var alarmParam = new IsupAlarmNative.NET_EHOME_ALARM_LISTEN_PARAM();
    alarmParam.Init();
    WriteAddress(ref alarmParam.struAddress, listenIp, alarmPort);
    alarmParam.fnMsgCb = alarmCallback;
    alarmParam.byProtocolType = alarmProtocol;
    alarmParam.dwKeepAliveSec = 30;
    alarmParam.dwTimeOutCount = 3;
    alarmListen = IsupAlarmNative.StartListen(ref alarmParam);
    if (alarmListen < 0)
    {
        WriteEvent(new
        {
            type = "warn",
            message = "NET_EALARM_StartListen 失敗，7663 可能被占用或防火牆未放行",
            errorCode = IsupAlarmNative.GetLastError(),
            alarmPort,
        });
    }
    else
    {
        WriteEvent(new { type = "ready", mode = "isup_alarm", alarmPort });
    }
}
catch (Exception exception)
{
    WriteEvent(new { type = "warn", message = "啟動 7663 告警監聽失敗", detail = exception.Message });
}

DEVICE_REGISTER_CB registerCallback = HandleRegister;
GC.KeepAlive(registerCallback);

var listenParam = new NET_EHOME_CMS_LISTEN_PARAM();
listenParam.struAddress.Init();
WriteAddress(ref listenParam.struAddress, listenIp, listenPort);
listenParam.fnCB = registerCallback;
listenParam.byRes = new byte[32];

int listenHandle;
try
{
    listenHandle = Invoke(NET_ECMS_StartListen(ref listenParam));
}
catch (Exception exception)
{
    WriteEvent(new
    {
        type = "error",
        message = "NET_ECMS_StartListen 失敗，請確認 7660 未被占用",
        detail = exception.Message,
    });
    if (alarmListen >= 0)
    {
        IsupAlarmNative.StopListen(alarmListen);
    }
    IsupAlarmNative.Fini();
    NET_ECMS_Fini();
    return 1;
}

WriteEvent(new
{
    type = "ready",
    mode = "isup_cms",
    listenPort,
    advertiseIp,
});

var exitEvent = new ManualResetEventSlim(false);
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    exitEvent.Set();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => exitEvent.Set();
exitEvent.Wait();

if (alarmListen >= 0)
{
    IsupAlarmNative.StopListen(alarmListen);
}
NET_ECMS_StopListen(listenHandle);
IsupAlarmNative.Fini();
NET_ECMS_Fini();
GC.KeepAlive(registerCallback);
GC.KeepAlive(alarmCallback);
WriteEvent(new { type = "stopped", mode = "isup_cms_alarm" });
return 0;

bool HandleRegister(
    int userId,
    int dataType,
    IntPtr outBuffer,
    int outLen,
    IntPtr inBuffer,
    int inLen,
    IntPtr user)
{
    NET_EHOME_DEV_REG_INFO_V12 deviceInfo = default;
    deviceInfo.Init();
    var shouldParse =
        dataType == ENUM_DEV_ON
        || dataType == ENUM_DEV_AUTH
        || dataType == ENUM_DEV_SESSIONKEY
        || dataType == ENUM_DEV_ADDRESS_CHANGED;
    if (shouldParse && outBuffer != IntPtr.Zero)
    {
        deviceInfo = Marshal.PtrToStructure<NET_EHOME_DEV_REG_INFO_V12>(outBuffer);
    }

    var deviceId = ReadCString(deviceInfo.struRegInfo.byDeviceID);
    var protocol = ReadCString(deviceInfo.struRegInfo.byDevProtocolVersion);
    var deviceIp = ReadCString(deviceInfo.struRegInfo.struDevAdd.szIP);

    if (dataType == ENUM_DEV_AUTH)
    {
        if (inBuffer == IntPtr.Zero)
        {
            WriteEvent(new { type = "error", message = "pInBuffer 為空，無法回密鑰", deviceId });
            return false;
        }

        var keyBytes = Encoding.ASCII.GetBytes(isupKey.PadRight(32, '\0'));
        Marshal.Copy(keyBytes, 0, inBuffer, keyBytes.Length);
        return true;
    }

    if (dataType == ENUM_DEV_SESSIONKEY)
    {
        var session = new NET_EHOME_DEV_SESSIONKEY();
        session.Init();
        session.sDeviceID ??= new byte[NET_EHOME_DEVICEID_LEN];
        session.sSessionKey ??= new byte[MAX_MASTER_KEY_LEN];
        if (deviceInfo.struRegInfo.byDeviceID != null)
        {
            deviceInfo.struRegInfo.byDeviceID.CopyTo(session.sDeviceID, 0);
        }
        if (deviceInfo.struRegInfo.bySessionKey != null)
        {
            deviceInfo.struRegInfo.bySessionKey.CopyTo(session.sSessionKey, 0);
        }
        var cmsOk = NET_ECMS_SetDeviceSessionKey(ref session);
        var alarmOk = IsupAlarmNative.SetDeviceSessionKey(ref session);
        if (!cmsOk || !alarmOk)
        {
            WriteEvent(new { type = "error", message = "SetDeviceSessionKey 失敗", deviceId, cmsOk, alarmOk });
        }
        return true;
    }

    if (dataType == ENUM_DEV_DAS_REQ)
    {
        if (inBuffer == IntPtr.Zero)
        {
            return false;
        }

        var payload = JsonSerializer.Serialize(new
        {
            Type = "DAS",
            DasInfo = new
            {
                Address = advertiseIp,
                Domain = "local.isup",
                ServerID = $"das_{advertiseIp}_{listenPort}",
                Port = (int)listenPort,
                UdpPort = (int)listenPort,
            },
        });
        var bytes = Encoding.ASCII.GetBytes(payload);
        Marshal.Copy(bytes, 0, inBuffer, bytes.Length);
        return true;
    }

    if (dataType == ENUM_DEV_ON)
    {
        if (inBuffer != IntPtr.Zero)
        {
            var serverInfo = Marshal.PtrToStructure<NET_EHOME_SERVER_INFO_V50>(inBuffer);
            serverInfo.dwKeepAliveSec = 15;
            serverInfo.dwTimeOutCount = 6;
            serverInfo.dwNTPInterval = 3600;
            WriteAddress(ref serverInfo.struTCPAlarmSever, advertiseIp, alarmPort);
            WriteAddress(ref serverInfo.struUDPAlarmSever, advertiseIp, alarmPort);
            serverInfo.dwAlarmServerType = alarmProtocol;
            Marshal.StructureToPtr(serverInfo, inBuffer, false);
        }

        WriteEvent(new { type = "online", deviceId, deviceIp });
        return true;
    }

    if (dataType == ENUM_DEV_OFF)
    {
        WriteEvent(new { type = "offline", deviceId });
        return true;
    }

    return true;
}

bool HandleAlarm(int handle, IntPtr alarmMsg, IntPtr user)
{
    try
    {
        if (alarmMsg == IntPtr.Zero)
        {
            return false;
        }

        var msg = Marshal.PtrToStructure<IsupAlarmNative.NET_EHOME_ALARM_MSG>(alarmMsg);
        var alarmType = (int)msg.dwAlarmType;
        if (msg.pHttpUrl != IntPtr.Zero && msg.dwHttpUrlLen > 0)
        {
            alarmType = IsupAlarmNative.AlarmIsapi;
        }

        string? payload = null;
        if (alarmType == IsupAlarmNative.AlarmIsapi && msg.pAlarmInfo != IntPtr.Zero)
        {
            var info = Marshal.PtrToStructure<IsupAlarmNative.NET_EHOME_ALARM_ISAPI_INFO>(msg.pAlarmInfo);
            payload = ReadNativeText(info.pAlarmData, info.dwAlarmDataLen);
        }
        else if (alarmType == IsupAlarmNative.AlarmAcs || alarmType == IsupAlarmNative.AlarmQrCode)
        {
            payload = ReadNativeText(msg.pAlarmInfo, msg.dwAlarmInfoLen)
                ?? ReadNativeText(msg.pXmlBuf, msg.dwXmlBufLen);
        }
        else
        {
            payload = ReadNativeText(msg.pXmlBuf, msg.dwXmlBufLen)
                ?? ReadNativeText(msg.pAlarmInfo, msg.dwAlarmInfoLen);
        }

        var scans = ExtractScans(payload, expectedDeviceId);
        foreach (var scan in scans)
        {
            WriteEvent(scan);
        }
        return true;
    }
    catch (Exception exception)
    {
        WriteEvent(new { type = "alarmError", message = exception.Message });
        return false;
    }
}

static void WriteAddress(ref NET_EHOME_IPADDRESS address, string ip, ushort port)
{
    address.Init();
    address.szIP ??= new byte[128];
    Array.Clear(address.szIP, 0, address.szIP.Length);
    var bytes = Encoding.ASCII.GetBytes(ip ?? "");
    Array.Copy(bytes, address.szIP, Math.Min(bytes.Length, address.szIP.Length - 1));
    address.wPort = port;
}

static void PrepareNativePath()
{
    var baseDir = AppContext.BaseDirectory;
    var candidates = new[]
    {
        Path.Combine(baseDir, "runtimes", "win-x64", "native"),
        Path.Combine(baseDir, "runtimes", "win7-x64", "native"),
        baseDir,
    };

    foreach (var directory in candidates)
    {
        if (!File.Exists(Path.Combine(directory, "HCISUPCMS.dll")))
        {
            continue;
        }

        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        Environment.SetEnvironmentVariable("PATH", directory + Path.PathSeparator + path);
        Directory.SetCurrentDirectory(directory);
        return;
    }
}

static string ReadEnv(string key, string fallback)
{
    var value = Environment.GetEnvironmentVariable(key);
    return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}

static string ReadCString(byte[]? bytes)
{
    if (bytes == null || bytes.Length == 0)
    {
        return "";
    }

    var end = Array.IndexOf(bytes, (byte)0);
    var length = end < 0 ? bytes.Length : end;
    return Encoding.ASCII.GetString(bytes, 0, length).Trim();
}

static string? ReadNativeText(IntPtr pointer, uint length)
{
    if (pointer == IntPtr.Zero || length == 0 || length > 8 * 1024 * 1024)
    {
        return null;
    }

    var buffer = new byte[length];
    Marshal.Copy(pointer, buffer, 0, buffer.Length);
    var end = buffer.Length;
    while (end > 0 && buffer[end - 1] <= 0x20)
    {
        end -= 1;
    }
    return end == 0 ? null : Encoding.UTF8.GetString(buffer, 0, end);
}

static List<object> ExtractScans(string? payload, string fallbackDeviceId)
{
    var scans = new List<object>();
    if (string.IsNullOrWhiteSpace(payload))
    {
        return scans;
    }

    JsonNode? node;
    try
    {
        node = JsonNode.Parse(payload);
    }
    catch (JsonException)
    {
        return scans;
    }

    var eventType = node?["eventType"]?.GetValue<string>()?.Trim() ?? "";
    if (!eventType.Equals("scannerInfo", StringComparison.OrdinalIgnoreCase))
    {
        return scans;
    }

    var deviceCode = node?["deviceID"]?.GetValue<string>()?.Trim();
    if (string.IsNullOrWhiteSpace(deviceCode))
    {
        deviceCode = fallbackDeviceId;
    }

    var items = node?["scannerInfo"] as JsonArray;
    if (items == null || items.Count == 0)
    {
        return scans;
    }

    foreach (var item in items)
    {
        var barcode = item?["orderNo"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(barcode))
        {
            continue;
        }

        var scannedAt = item?["scannerTime"]?.GetValue<string>()?.Trim()
            ?? node?["dateTime"]?.GetValue<string>()?.Trim();
        scans.Add(new
        {
            type = "scan",
            deviceCode,
            barcode,
            scannedAt,
        });
    }

    return scans;
}

static void WriteEvent(object payload)
{
    Console.WriteLine(JsonSerializer.Serialize(payload, IsupEventJson.Options));
    Console.Out.Flush();
}

file static class IsupEventJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}
