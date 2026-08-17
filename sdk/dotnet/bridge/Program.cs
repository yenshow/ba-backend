using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using HcNetSdkCommon;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

if (args.Length > 0 && args[0] == "--arming")
{
    return await RunArmingDaemonAsync(jsonOptions);
}

if (args.Length > 0 && args[0] == "--arming-intercom")
{
    return await RunIntercomArmingDaemonAsync(jsonOptions);
}

var stdin = await Console.In.ReadToEndAsync();
if (string.IsNullOrWhiteSpace(stdin))
{
    await WriteResponseAsync(jsonOptions, new BridgeResponse(false, "EMPTY_REQUEST", "請提供 JSON 請求"));
    return 1;
}

BridgeRequest? request;
try
{
    request = JsonSerializer.Deserialize<BridgeRequest>(stdin, jsonOptions);
}
catch (Exception ex)
{
    await WriteResponseAsync(jsonOptions, new BridgeResponse(false, "INVALID_JSON", ex.Message));
    return 1;
}

if (request == null || string.IsNullOrWhiteSpace(request.Action))
{
    await WriteResponseAsync(jsonOptions, new BridgeResponse(false, "INVALID_REQUEST", "缺少 action"));
    return 1;
}

if (request.Device == null ||
    string.IsNullOrWhiteSpace(request.Device.Host) ||
    string.IsNullOrWhiteSpace(request.Device.Username) ||
    string.IsNullOrWhiteSpace(request.Device.Password))
{
    await WriteResponseAsync(jsonOptions, new BridgeResponse(false, "DEVICE_INCOMPLETE", "設備連線參數不完整"));
    return 1;
}

try
{
    var response = HandleRequest(request);
    await WriteResponseAsync(jsonOptions, response);
    return response.Ok ? 0 : 1;
}
catch (Exception ex)
{
    await WriteResponseAsync(jsonOptions, new BridgeResponse(false, "INTERNAL_ERROR", ex.Message));
    return 1;
}

static BridgeResponse HandleRequest(BridgeRequest request)
{
    using var session = new SdkDeviceSession();
    var port = request.Device!.Port > 0 ? request.Device.Port : 8000;
    if (!session.Connect(request.Device.Host, port, request.Device.Username, request.Device.Password))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        return new BridgeResponse(false, "LOGIN_FAILED", SdkErrorHelper.Explain(err), new { errorCode = err });
    }

    return request.Action.Trim().ToLowerInvariant() switch
    {
        "card.list" => HandleCardList(session),
        "card.get" => HandleCardGet(session, request.Payload),
        "card.create" => HandleCardWrite(session, request.Payload, SdkCardAction.Create),
        "card.update" => HandleCardWrite(session, request.Payload, SdkCardAction.Update),
        "card.delete" => HandleCardDelete(session, request.Payload),
        "control.gateway" => HandleControlGateway(session, request.Payload),
        "door.list" => HandleDoorList(session, request.Payload),
        "door.get" => HandleDoorGet(session, request.Payload),
        "door.set" => HandleDoorSet(session, request.Payload),
        "isapi.request" => HandleIsapiRequest(session, request.Payload),
        "ability.probe" => HandleAbilityProbe(session, request.Payload),
        _ => new BridgeResponse(false, "UNKNOWN_ACTION", $"不支援的 action: {request.Action}"),
    };
}

static BridgeResponse HandleCardList(SdkDeviceSession session)
{
    var maxFloor = SdkCardService.QueryMaxFloor(session.UserId);
    var (ok, cards, error) = SdkCardService.GetCards(session.UserId, SdkCardAction.List, string.Empty);
    if (!ok)
    {
        return new BridgeResponse(false, "CARD_READ_FAILED", error);
    }

    var items = cards.Select(card => SdkCardJson.ToCardObject(card, maxFloor)).ToList();
    return new BridgeResponse(true, null, null, new { maxFloor, cards = items, total = items.Count });
}

static BridgeResponse HandleCardGet(SdkDeviceSession session, JsonElement? payload)
{
    var cardNo = ReadString(payload, "cardNo");
    if (string.IsNullOrWhiteSpace(cardNo))
    {
        return new BridgeResponse(false, "CARD_NO_REQUIRED", "請提供 cardNo");
    }

    var maxFloor = SdkCardService.QueryMaxFloor(session.UserId);
    var (ok, cards, error) = SdkCardService.GetCards(session.UserId, SdkCardAction.Get, cardNo);
    if (!ok)
    {
        return new BridgeResponse(false, "CARD_READ_FAILED", error);
    }

    if (cards.Count == 0)
    {
        return new BridgeResponse(false, "CARD_NOT_FOUND", $"找不到卡號 {cardNo}");
    }

    return new BridgeResponse(true, null, null, SdkCardJson.ToCardObject(cards[0], maxFloor));
}

static BridgeResponse HandleCardWrite(
    SdkDeviceSession session,
    JsonElement? payload,
    SdkCardAction action)
{
    var writeRequest = ParseWriteRequest(payload, action == SdkCardAction.Delete);
    if (writeRequest == null)
    {
        return new BridgeResponse(false, "INVALID_PAYLOAD", "卡片寫入參數不完整");
    }

    if (action == SdkCardAction.Delete)
    {
        writeRequest = writeRequest with { Delete = true, Floors = [] };
    }

    ApplyFloorMode(payload);
    var (ok, error) = SdkCardService.WriteCard(session.UserId, writeRequest, action);
    if (!ok)
    {
        return new BridgeResponse(false, "CARD_WRITE_FAILED", error);
    }

    return new BridgeResponse(true, null, null, new { action = action.ToString().ToLowerInvariant() });
}

static BridgeResponse HandleCardDelete(SdkDeviceSession session, JsonElement? payload) =>
    HandleCardWrite(session, payload, SdkCardAction.Delete);

static BridgeResponse HandleControlGateway(SdkDeviceSession session, JsonElement? payload)
{
    var gatewayIndex = ReadInt(payload, "gatewayIndex", 1);
    var command = ReadUInt(payload, "command", HcNetSdkNative.GatewayOpen);

    if (gatewayIndex < -1 || gatewayIndex == 0)
    {
        return new BridgeResponse(false, "INVALID_GATEWAY", "gatewayIndex 須為 -1 或 >= 1");
    }

    if (!HcNetSdkNative.NET_DVR_ControlGateway(session.UserId, gatewayIndex, command))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        return new BridgeResponse(false, "CONTROL_FAILED", SdkErrorHelper.Explain(err), new { errorCode = err });
    }

    return new BridgeResponse(true, null, null, new
    {
        gatewayIndex,
        command,
        commandName = SdkGatewayHelper.CommandName(command),
    });
}

static BridgeResponse HandleDoorList(SdkDeviceSession session, JsonElement? payload)
{
    var limit = ReadInt(payload, "limit", 0);
    var maxDoor = SdkDoorService.QueryMaxDoor(session.UserId);
    var (ok, doors, error) = SdkDoorService.ListDoors(
        session.UserId,
        limit > 0 ? limit : null);
    if (!ok)
    {
        return new BridgeResponse(false, "DOOR_READ_FAILED", error);
    }

    return new BridgeResponse(true, null, null, new
    {
        maxDoor,
        doors = doors.Select(d => new { d.DoorIndex, name = d.Name, d.OpenDuration, d.LadderControlDelayTime }),
        total = doors.Count,
    });
}

static BridgeResponse HandleDoorGet(SdkDeviceSession session, JsonElement? payload)
{
    var doorIndex = ReadInt(payload, "doorIndex", 0);
    if (doorIndex < 1)
    {
        return new BridgeResponse(false, "DOOR_INDEX_REQUIRED", "請提供 doorIndex（>= 1）");
    }

    var (ok, door, error) = SdkDoorService.GetDoor(session.UserId, doorIndex);
    if (!ok)
    {
        return new BridgeResponse(false, "DOOR_READ_FAILED", error);
    }

    return new BridgeResponse(true, null, null, new
    {
        doorIndex = door.DoorIndex,
        name = door.Name,
        door.OpenDuration,
        door.LadderControlDelayTime,
    });
}

static BridgeResponse HandleIsapiRequest(SdkDeviceSession session, JsonElement? payload)
{
    var method = ReadString(payload, "method") ?? "GET";
    var path = ReadString(payload, "path");
    if (string.IsNullOrWhiteSpace(path))
    {
        return new BridgeResponse(false, "INVALID_PAYLOAD", "請提供 path");
    }

    var body = ReadString(payload, "body");
    var timeoutMs = ReadInt(payload, "timeoutMs", 15000);
    var result = SdkStdXmlService.Request(session.UserId, method, path!, body, timeoutMs);

    var message = result.Ok
        ? null
        : result.StatusString
          ?? result.SubStatusCode
          ?? SdkErrorHelper.Explain(result.ErrorCode);

    // 通話測試需要讀 body／status，即使設備回 notSupport 仍回 ok=true + 細項
    return new BridgeResponse(true, null, null, new
    {
        ok = result.Ok,
        method,
        path,
        errorCode = result.Ok ? (uint?)null : result.ErrorCode,
        error = message,
        statusString = result.StatusString,
        subStatusCode = result.SubStatusCode,
        statusBody = string.IsNullOrWhiteSpace(result.StatusBody) ? null : result.StatusBody,
        body = string.IsNullOrWhiteSpace(result.Body) ? null : result.Body,
    });
}

static BridgeResponse HandleAbilityProbe(SdkDeviceSession session, JsonElement? payload)
{
    var sdkResults = new List<object>();
    var isapiResults = new List<object>();
    var root = GetPayloadRoot(payload);

    if (root is JsonElement obj &&
        obj.TryGetProperty("sdkAbilities", out var sdkArr) &&
        sdkArr.ValueKind == JsonValueKind.Array)
    {
        foreach (var item in sdkArr.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var name = ReadString(item, "name") ?? "unnamed";
            var abilityType = ReadAbilityType(item);
            var inXml = ReadString(item, "inXml");
            var result = SdkAbilityHelper.Query(session.UserId, abilityType, inXml);
            sdkResults.Add(new
            {
                name,
                abilityType,
                ok = result.Ok,
                errorCode = result.Ok ? (uint?)null : result.ErrorCode,
                error = result.Ok ? null : SdkErrorHelper.Explain(result.ErrorCode),
                xml = string.IsNullOrWhiteSpace(result.Xml) ? null : result.Xml,
            });
        }
    }

    if (root is JsonElement isapiRoot &&
        isapiRoot.TryGetProperty("isapiPaths", out var isapiArr) &&
        isapiArr.ValueKind == JsonValueKind.Array)
    {
        foreach (var item in isapiArr.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var name = ReadString(item, "name") ?? "unnamed";
            var method = ReadString(item, "method") ?? "GET";
            var path = ReadString(item, "path");
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }

            var timeoutMs = ReadInt(item, "timeoutMs", 15000);
            var result = SdkStdXmlService.Request(session.UserId, method, path!, null, timeoutMs);
            var message = result.Ok
                ? null
                : result.StatusString
                  ?? result.SubStatusCode
                  ?? SdkErrorHelper.Explain(result.ErrorCode);

            isapiResults.Add(new
            {
                name,
                method,
                path,
                ok = result.Ok,
                errorCode = result.Ok ? (uint?)null : result.ErrorCode,
                error = message,
                statusString = result.StatusString,
                subStatusCode = result.SubStatusCode,
                statusBody = string.IsNullOrWhiteSpace(result.StatusBody) ? null : result.StatusBody,
                body = string.IsNullOrWhiteSpace(result.Body) ? null : result.Body,
            });
        }
    }

    return new BridgeResponse(true, null, null, new
    {
        sdk = sdkResults,
        isapi = isapiResults,
    });
}

static uint ReadAbilityType(JsonElement item)
{
    if (!item.TryGetProperty("abilityType", out var value))
    {
        return 0;
    }

    if (value.ValueKind == JsonValueKind.Number && value.TryGetUInt32(out var numeric))
    {
        return numeric;
    }

    if (value.ValueKind == JsonValueKind.String)
    {
        var raw = value.GetString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                return Convert.ToUInt32(raw, 16);
            }
            catch
            {
                return 0;
            }
        }

        return uint.TryParse(raw, out var parsed) ? parsed : 0;
    }

    return 0;
}

static BridgeResponse HandleDoorSet(SdkDeviceSession session, JsonElement? payload)
{
    var doorIndex = ReadInt(payload, "doorIndex", 0);
    var name = ReadString(payload, "name");
    var (openDuration, openDurationError) = ReadOpenDuration(payload);
    if (doorIndex < 1)
    {
        return new BridgeResponse(false, "DOOR_INDEX_REQUIRED", "請提供 doorIndex（>= 1）");
    }

    if (openDurationError != null)
    {
        return new BridgeResponse(false, "DOOR_OPEN_DURATION_INVALID", openDurationError);
    }

    if (name == null && openDuration == null)
    {
        return new BridgeResponse(false, "DOOR_PARAM_REQUIRED", "請提供 name 或 openDuration");
    }

    var (ok, error) = SdkDoorService.SetDoor(session.UserId, doorIndex, name, openDuration);
    if (!ok)
    {
        return new BridgeResponse(false, "DOOR_WRITE_FAILED", error);
    }

    return new BridgeResponse(true, null, null, new { doorIndex, name, openDuration });
}

static void ApplyFloorMode(JsonElement? payload)
{
    var mode = ReadString(payload, "floorMode");
    if (!string.IsNullOrWhiteSpace(mode))
    {
        Environment.SetEnvironmentVariable("SDK_CARD_FLOOR_MODE", mode);
    }
}

static SdkCardWriteRequest? ParseWriteRequest(JsonElement? payload, bool delete)
{
    if (payload == null || payload.Value.ValueKind != JsonValueKind.Object)
    {
        return null;
    }

    var root = payload.Value;
    var payloadElement = (JsonElement?)root;
    var cardNo = ReadString(payloadElement, "cardNo");
    if (string.IsNullOrWhiteSpace(cardNo))
    {
        return null;
    }

    var floors = ReadIntArray(root, "floors", delete);
    if (!delete && floors.Length == 0)
    {
        return null;
    }

    return new SdkCardWriteRequest(
        CardNo: cardNo,
        Floors: floors,
        HomeFloor: (short)ReadInt(payloadElement, "homeFloor", 1),
        Name: ReadString(payloadElement, "name"),
        EmployeeNo: ReadUInt(payloadElement, "employeeNo", 0),
        Password: ReadString(payloadElement, "password"),
        CardType: (byte)ReadInt(payloadElement, "cardType", 1),
        ValidEnabled: ReadBool(root, "validEnabled"),
        ValidBegin: ReadDate(root, "validBegin"),
        ValidEnd: ReadDate(root, "validEnd"),
        Delete: delete);
}

static async Task<int> RunIntercomArmingDaemonAsync(JsonSerializerOptions jsonOptions)
{
    var (host, port, user, pass) = SdkEnv.ReadDeviceCredentials(
        defaultHost: "192.168.2.27",
        defaultPort: 8000,
        defaultUser: "admin");
    if (!SdkEnv.RequirePassword(pass))
    {
        await WriteLineJsonAsync(jsonOptions, new { type = "error", message = "缺少 SDK_DEVICE_PASS" });
        return 1;
    }

    using var session = new SdkDeviceSession();
    if (!session.Connect(host, port, user, pass))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new
        {
            type = "error",
            message = SdkErrorHelper.Explain(err),
            errorCode = err,
        });
        return 1;
    }

    // 必須保留 callback 參考，避免 GC 回收後 SDK 回呼崩潰
    var callback = new HcNetSdkNative.MsgCallback(HandleIntercomMessage);
    GC.KeepAlive(callback);

    if (!HcNetSdkNative.NET_DVR_SetDVRMessageCallBack_V50(0, callback, IntPtr.Zero))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new
        {
            type = "error",
            message = "設定回調失敗",
            errorCode = err,
        });
        return 1;
    }

    var setup = new HcNetSdkNative.NET_DVR_SETUPALARM_PARAM_V50
    {
        dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_SETUPALARM_PARAM_V50>(),
        byLevel = 0,
        byAlarmInfoType = 1,
        byRetAlarmTypeV40 = 1,
        byDeployType = 1,
        bySupport = 0xFF,
        byBrokenNetHttp = 0xFF,
        byBrokenNetHttpV60 = 0xFF,
        byAlarmTypeURL = 0,
        byRes4 = new byte[128],
    };

    var alarmHandle = HcNetSdkNative.NET_DVR_SetupAlarmChan_V50(
        session.UserId,
        ref setup,
        IntPtr.Zero,
        0);
    if (alarmHandle < 0)
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new
        {
            type = "error",
            message = SdkErrorHelper.Explain(err),
            errorCode = err,
        });
        return 1;
    }

    await WriteLineJsonAsync(jsonOptions, new
    {
        type = "ready",
        mode = "video_intercom",
        alarmHandle,
        host,
        port,
        filter = "none",
        listen =
            new[]
            {
                "COMM_ISAPI_ALARM(0x6009)",
                "COMM_UPLOAD_VIDEO_INTERCOM_EVENT(0x1132)",
                "COMM_ALARM_VIDEO_INTERCOM(0x1133)",
                "COMM_ALARM_ACS(0x5002)",
                "ANY(raw)",
            },
    });

    var exitEvent = new ManualResetEventSlim(false);
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        exitEvent.Set();
    };
    AppDomain.CurrentDomain.ProcessExit += (_, _) => exitEvent.Set();
    exitEvent.Wait();

    HcNetSdkNative.NET_DVR_CloseAlarmChan_V30(alarmHandle);
    GC.KeepAlive(callback);
    await WriteLineJsonAsync(jsonOptions, new { type = "stopped", mode = "video_intercom" });
    return 0;

    void HandleIntercomMessage(
        int lCommand,
        ref HcNetSdkNative.NET_DVR_ALARMER pAlarmer,
        IntPtr pAlarmInfo,
        uint dwBufLen,
        IntPtr pUser)
    {
        var deviceIp = ReadAlarmerIp(ref pAlarmer);
        var serial = ReadAlarmerSerial(ref pAlarmer);
        var now = DateTimeOffset.Now.ToString("o");

        if (lCommand == VideoIntercomAlarmHelper.CommIsapiAlarm &&
            VideoIntercomAlarmHelper.TryParseIsapiAlarm(pAlarmInfo, dwBufLen, out var isapi))
        {
            WriteLineJsonAsync(jsonOptions, new
            {
                type = "event",
                category = "isapi_alarm",
                command = $"0x{lCommand:X4}",
                commandName = "COMM_ISAPI_ALARM",
                dataType = isapi.DataTypeName,
                dataLen = isapi.DataLen,
                summary = isapi.Summary,
                body = isapi.Text,
                sourceIp = deviceIp,
                serial,
                timestamp = now,
            }).GetAwaiter().GetResult();
            return;
        }

        if (VideoIntercomAlarmHelper.TryParse(lCommand, pAlarmInfo, dwBufLen, out var intercom))
        {
            WriteLineJsonAsync(jsonOptions, new
            {
                type = "event",
                category = intercom.Kind,
                command = $"0x{lCommand:X4}",
                eventType = intercom.EventOrAlarmType,
                eventName = intercom.TypeName,
                deviceNumber = string.IsNullOrEmpty(intercom.DeviceNumber) ? null : intercom.DeviceNumber,
                deviceTime = string.IsNullOrEmpty(intercom.Time) ? null : intercom.Time,
                iotChannelNo = intercom.IotChannelNo > 0 ? intercom.IotChannelNo : (uint?)null,
                detail = intercom.Detail,
                sourceIp = deviceIp,
                serial,
                timestamp = now,
            }).GetAwaiter().GetResult();
            return;
        }

        if (lCommand == HcNetSdkNative.CommAlarmAcs &&
            SdkAlarmHelper.TryParse(pAlarmInfo, dwBufLen, out var acs))
        {
            WriteLineJsonAsync(jsonOptions, new
            {
                type = "event",
                category = "acs",
                command = $"0x{lCommand:X4}",
                major = acs.Major,
                minor = acs.Minor,
                eventName = AcsEventNames.Format(acs.Major, acs.Minor),
                doorNo = acs.DoorNo > 0 ? acs.DoorNo : (uint?)null,
                cardNo = string.IsNullOrEmpty(acs.CardNo) || acs.CardNo == "0" ? null : acs.CardNo,
                sourceIp = deviceIp,
                serial,
                timestamp = now,
            }).GetAwaiter().GetResult();
            return;
        }

        // 其餘事件先以 raw 輸出，方便現場對照來電／通話信令
        WriteLineJsonAsync(jsonOptions, new
        {
            type = "raw",
            category = "unknown",
            command = $"0x{lCommand:X4}",
            commandDec = lCommand,
            bufLen = dwBufLen,
            hexPreview = VideoIntercomAlarmHelper.HexPreview(pAlarmInfo, dwBufLen),
            sourceIp = deviceIp,
            serial,
            timestamp = now,
        }).GetAwaiter().GetResult();
    }
}

static string? ReadAlarmerIp(ref HcNetSdkNative.NET_DVR_ALARMER alarmer)
{
    if (alarmer.byDeviceIPValid == 0 || alarmer.sDeviceIP == null)
    {
        return null;
    }

    var end = Array.IndexOf(alarmer.sDeviceIP, (byte)0);
    var len = end >= 0 ? end : alarmer.sDeviceIP.Length;
    if (len <= 0)
    {
        return null;
    }

    return Encoding.ASCII.GetString(alarmer.sDeviceIP, 0, len).Trim();
}

static string? ReadAlarmerSerial(ref HcNetSdkNative.NET_DVR_ALARMER alarmer)
{
    if (alarmer.bySerialValid == 0 || alarmer.sSerialNumber == null)
    {
        return null;
    }

    var end = Array.IndexOf(alarmer.sSerialNumber, (byte)0);
    var len = end >= 0 ? end : alarmer.sSerialNumber.Length;
    if (len <= 0)
    {
        return null;
    }

    return Encoding.ASCII.GetString(alarmer.sSerialNumber, 0, len).Trim();
}

static async Task<int> RunArmingDaemonAsync(JsonSerializerOptions jsonOptions)
{
    var (host, port, user, pass) = SdkEnv.ReadDeviceCredentials();
    if (!SdkEnv.RequirePassword(pass))
    {
        await WriteLineJsonAsync(jsonOptions, new { type = "error", message = "缺少 SDK_DEVICE_PASS" });
        return 1;
    }

    using var session = new SdkDeviceSession();
    if (!session.Connect(host, port, user, pass))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new { type = "error", message = SdkErrorHelper.Explain(err), errorCode = err });
        return 1;
    }

    var callback = new HcNetSdkNative.MsgCallback(HandleAlarmMessage);
    if (!HcNetSdkNative.NET_DVR_SetDVRMessageCallBack_V50(0, callback, IntPtr.Zero))
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new { type = "error", message = "設定回調失敗", errorCode = err });
        return 1;
    }

    var setup = new HcNetSdkNative.NET_DVR_SETUPALARM_PARAM_V50
    {
        dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_SETUPALARM_PARAM_V50>(),
        byLevel = 1,
        byAlarmInfoType = 1,
        byRes4 = new byte[128],
    };

    var alarmHandle = HcNetSdkNative.NET_DVR_SetupAlarmChan_V50(session.UserId, ref setup, IntPtr.Zero, 0);
    if (alarmHandle < 0)
    {
        var err = HcNetSdkNative.NET_DVR_GetLastError();
        await WriteLineJsonAsync(jsonOptions, new { type = "error", message = SdkErrorHelper.Explain(err), errorCode = err });
        return 1;
    }

    await WriteLineJsonAsync(jsonOptions, new { type = "ready", alarmHandle, host, port });

    var exitEvent = new ManualResetEventSlim(false);
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        exitEvent.Set();
    };
    AppDomain.CurrentDomain.ProcessExit += (_, _) => exitEvent.Set();
    exitEvent.Wait();

    HcNetSdkNative.NET_DVR_CloseAlarmChan_V30(alarmHandle);
    await WriteLineJsonAsync(jsonOptions, new { type = "stopped" });
    return 0;

    void HandleAlarmMessage(
        int lCommand,
        ref HcNetSdkNative.NET_DVR_ALARMER pAlarmer,
        IntPtr pAlarmInfo,
        uint dwBufLen,
        IntPtr pUser)
    {
        if (lCommand != HcNetSdkNative.CommAlarmAcs)
        {
            return;
        }

        if (!SdkAlarmHelper.TryParse(pAlarmInfo, dwBufLen, out var evt))
        {
            return;
        }

        var payload = new
        {
            type = "event",
            major = evt.Major,
            minor = evt.Minor,
            eventName = AcsEventNames.Format(evt.Major, evt.Minor),
            floor = evt.DoorNo > 0 ? evt.DoorNo : (uint?)null,
            cardNo = string.IsNullOrEmpty(evt.CardNo) || evt.CardNo == "0" ? null : evt.CardNo,
            timestamp = DateTimeOffset.Now.ToString("o"),
        };

        WriteLineJsonAsync(jsonOptions, payload).GetAwaiter().GetResult();
    }
}

static JsonElement? GetPayloadRoot(JsonElement? payload)
{
    if (payload == null || payload.Value.ValueKind != JsonValueKind.Object)
    {
        return null;
    }

    return payload.Value;
}

static string? ReadString(JsonElement? payload, string name)
{
    var root = GetPayloadRoot(payload);
    if (root == null || !root.Value.TryGetProperty(name, out var value))
    {
        return null;
    }

    return value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetRawText(),
        _ => null,
    };
}

static int ReadInt(JsonElement? payload, string name, int fallback = 0)
{
    var root = GetPayloadRoot(payload);
    if (root == null || !root.Value.TryGetProperty(name, out var value))
    {
        return fallback;
    }

    return value.ValueKind switch
    {
        JsonValueKind.Number => value.TryGetInt32(out var n) ? n : fallback,
        JsonValueKind.String => int.TryParse(value.GetString(), out var parsed) ? parsed : fallback,
        _ => fallback,
    };
}

static (byte? Value, string? Error) ReadOpenDuration(JsonElement? payload)
{
    var root = GetPayloadRoot(payload);
    if (root == null || !root.Value.TryGetProperty("openDuration", out var value))
    {
        return (null, null);
    }

    var duration = value.ValueKind switch
    {
        JsonValueKind.Number => value.TryGetInt32(out var n) ? n : -1,
        JsonValueKind.String => int.TryParse(value.GetString(), out var parsed) ? parsed : -1,
        _ => -1,
    };

    if (duration is < 1 or > 255)
    {
        return (null, "openDuration 須為 1-255（秒）");
    }

    return ((byte)duration, null);
}

static uint ReadUInt(JsonElement? payload, string name, uint fallback = 0)
{
    var value = ReadInt(payload, name, (int)fallback);
    return value < 0 ? fallback : (uint)value;
}

static bool ReadBool(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var value))
    {
        return false;
    }

    return value.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => value.GetString() is "1" or "true" or "True" or "yes",
        JsonValueKind.Number => value.TryGetInt32(out var n) && n != 0,
        _ => false,
    };
}

static DateTime? ReadDate(JsonElement root, string name)
{
    var raw = ReadString(root, name);
    return DateTime.TryParse(raw, out var value) ? value : null;
}

static int[] ReadIntArray(JsonElement root, string name, bool _ = false)
{
    if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
    {
        return [];
    }

    return value.EnumerateArray()
        .Select(item => item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var n)
            ? n
            : int.TryParse(item.GetString(), out var parsed) ? parsed : 0)
        .Where(floor => floor > 0)
        .ToArray();
}

static async Task WriteResponseAsync(JsonSerializerOptions jsonOptions, BridgeResponse response)
{
    var json = JsonSerializer.Serialize(response, jsonOptions);
    await Console.Out.WriteLineAsync(json);
}

static async Task WriteLineJsonAsync(JsonSerializerOptions jsonOptions, object payload)
{
    var json = JsonSerializer.Serialize(payload, jsonOptions);
    await Console.Out.WriteLineAsync(json);
}

internal sealed record BridgeDevice(
    string Host,
    int Port,
    string Username,
    string Password);

internal sealed record BridgeRequest(
    string Action,
    BridgeDevice? Device,
    JsonElement? Payload);

internal sealed class BridgeResponse
{
    public BridgeResponse(bool ok, string? code, string? message, object? data = null)
    {
        Ok = ok;
        Code = code;
        Message = message;
        Data = data;
    }

    public bool Ok { get; }
    public string? Code { get; }
    public string? Message { get; }
    public object? Data { get; }
}
