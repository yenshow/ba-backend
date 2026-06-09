using System.Runtime.InteropServices;
using System.Text;

namespace HcNetSdkCommon;

internal static class HcNetSdkNative
{
    public const int CommAlarmAcs = 0x5002;
    public const int NameLen = 32;
    public const int AcsCardNoLen = 32;
    public const int CardPasswordLen = 8;
    public const int MaxDoorNum256 = 256;
    public const int MaxCardRightPlanNum = 4;
    public const int MaxGroupNum128 = 128;
    public const int MaxLockCodeLen = 8;
    public const int MaxDoorCodeLen = 8;

    public const uint AcsAbility = 0x801;
    public const uint NetDvrGetCardCfgV50 = 2178;
    public const uint NetDvrSetCardCfgV50 = 2179;
    public const uint EnumAcsSendData = 3;

    public const uint NetSdkCallbackTypeStatus = 0;
    public const uint NetSdkCallbackTypeData = 2;
    public const uint NetSdkCallbackStatusSuccess = 1000;
    public const uint NetSdkCallbackStatusProcessing = 1001;
    public const uint NetSdkCallbackStatusFailed = 1002;
    public const uint NetSdkCallbackStatusException = 1003;

    public const uint CardParamCardValid = 0x00000001;
    public const uint CardParamValid = 0x00000002;
    public const uint CardParamCardType = 0x00000004;
    public const uint CardParamDoorRight = 0x00000008;
    public const uint CardParamPassword = 0x00000080;
    public const uint CardParamEmployeeNo = 0x00000400;
    public const uint CardParamName = 0x00000800;
    public const uint CardParamFloorNumber = 0x00020000;

    public const uint GatewayClose = 0;
    public const uint GatewayOpen = 1;
    public const uint GatewayAlwaysOpen = 2;
    public const uint GatewayAlwaysClose = 3;
    public const uint GatewayRecovery = 4;
    public const uint GatewayVisitorCall = 5;
    public const uint GatewayResidentCall = 6;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate void MsgCallback(
        int lCommand,
        ref NET_DVR_ALARMER pAlarmer,
        IntPtr pAlarmInfo,
        uint dwBufLen,
        IntPtr pUser);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate void RemoteConfigCallback(
        uint dwType,
        IntPtr lpBuffer,
        uint dwBufLen,
        IntPtr pUserData);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct NET_DVR_USER_LOGIN_INFO
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)]
        public string sDeviceAddress;

        public byte byUseTransport;
        public ushort wPort;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string sUserName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string sPassword;

        public IntPtr cbLoginResult;
        public IntPtr pUser;
        public int bUseAsynLogin;
        public byte byProxyType;
        public byte byUseUTCTime;
        public byte byLoginMode;
        public byte byHttps;
        public int iProxyID;
        public byte byVerifyMode;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 119)]
        public byte[] byRes3;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_TIME_EX
    {
        public ushort wYear;
        public byte byMonth;
        public byte byDay;
        public byte byHour;
        public byte byMinute;
        public byte bySecond;
        public byte byRes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_VALID_PERIOD_CFG
    {
        public byte byEnable;
        public byte byBeginTimeFlag;
        public byte byEnableTimeFlag;
        public byte byTimeDurationNo;
        public NET_DVR_TIME_EX struBeginTime;
        public NET_DVR_TIME_EX struEndTime;
        public byte byTimeType;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 31)]
        public byte[] byRes2;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    public struct NET_DVR_CARD_CFG_SEND_DATA
    {
        public uint dwSize;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = AcsCardNoLen)]
        public byte[] byCardNo;

        public uint dwCardUserId;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 12)]
        public byte[] byRes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    public struct NET_DVR_CARD_CFG_COND
    {
        public uint dwSize;
        public uint dwCardNum;
        public byte byCheckCardNo;
        public byte byRes1_0;
        public byte byRes1_1;
        public byte byRes1_2;
        public ushort wLocalControllerID;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes2;

        public uint dwLockID;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 20)]
        public byte[] byRes3;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    public struct NET_DVR_CARD_CFG_V50
    {
        public uint dwSize;
        public uint dwModifyParamType;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = AcsCardNoLen)]
        public byte[] byCardNo;

        public byte byCardValid;
        public byte byCardType;
        public byte byLeaderCard;
        public byte byUserType;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxDoorNum256)]
        public byte[] byDoorRight;

        public NET_DVR_VALID_PERIOD_CFG struValid;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxGroupNum128)]
        public byte[] byBelongGroup;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = CardPasswordLen)]
        public byte[] byCardPassword;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxDoorNum256 * MaxCardRightPlanNum * 2)]
        public byte[] wCardRightPlan;

        public uint dwMaxSwipeTime;
        public uint dwSwipeTime;
        public ushort wRoomNumber;
        public short wFloorNumber;
        public uint dwEmployeeNo;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = NameLen)]
        public byte[] byName;

        public ushort wDepartmentNo;
        public ushort wSchedulePlanNo;
        public byte bySchedulePlanType;
        public byte byRightType;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes2;

        public uint dwLockID;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxLockCodeLen)]
        public byte[] byLockCode;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxDoorCodeLen)]
        public byte[] byRoomCode;

        public uint dwCardRight;
        public uint dwPlanTemplate;
        public uint dwCardUserId;
        public byte byCardModelType;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 51)]
        public byte[] byRes3;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = NameLen)]
        public byte[] bySIMNum;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_SETUPALARM_PARAM_V50
    {
        public uint dwSize;
        public byte byLevel;
        public byte byAlarmInfoType;
        public byte byRetAlarmTypeV40;
        public byte byRetDevInfoVersion;
        public byte byRetVQDAlarmType;
        public byte byFaceAlarmDetection;
        public byte bySupport;
        public byte byBrokenNetHttp;
        public ushort wTaskNo;
        public byte byDeployType;
        public byte bySubScription;
        public byte byBrokenNetHttpV60;
        public byte byRes1;
        public byte byAlarmTypeURL;
        public byte byCustomCtrl;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)]
        public byte[] byRes4;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_DVR_ACS_ALARM_INFO
    {
        public uint dwSize;
        public uint dwMajor;
        public uint dwMinor;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct NET_DVR_ALARMER
    {
        public byte byUserIDValid;
        public byte bySerialValid;
        public byte byVersionValid;
        public byte byDeviceNameValid;
        public byte byMacAddrValid;
        public byte byLinkPortValid;
        public byte byDeviceIPValid;
        public byte bySocketIPValid;
        public int lUserID;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 48)]
        public byte[] sSerialNumber;

        public uint dwDeviceVersion;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = NameLen)]
        public byte[] sDeviceName;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
        public byte[] byMacAddr;

        public ushort wLinkPort;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)]
        public byte[] sDeviceIP;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)]
        public byte[] sSocketIP;

        public byte byIpProtocol;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes1;

        public byte bJSONBroken;
        public ushort wSocketPort;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
        public byte[] byRes2;
    }

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_Init();

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_Cleanup();

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_SetConnectTime(uint dwWaitTime, uint dwTryTimes);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_SetReconnect(uint dwInterval, bool bEnableRecon);

    [DllImport("HCNetSDK.dll")]
    public static extern int NET_DVR_Login_V40(
        ref NET_DVR_USER_LOGIN_INFO pLoginInfo,
        IntPtr lpDeviceInfo);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_Logout(int lUserID);

    [DllImport("HCNetSDK.dll")]
    public static extern uint NET_DVR_GetLastError();

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_SetDVRMessageCallBack_V50(
        int iIndex,
        MsgCallback fMessageCallBack,
        IntPtr pUser);

    [DllImport("HCNetSDK.dll")]
    public static extern int NET_DVR_SetupAlarmChan_V50(
        int lUserID,
        ref NET_DVR_SETUPALARM_PARAM_V50 lpSetupParam,
        IntPtr pSub,
        uint dwSubSize);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_CloseAlarmChan_V30(int lAlarmHandle);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_ControlGateway(int lUserID, int lGatewayIndex, uint dwStaic);

    [DllImport("HCNetSDK.dll")]
    public static extern int NET_DVR_StartRemoteConfig(
        int lUserID,
        uint dwCommand,
        ref NET_DVR_CARD_CFG_COND lpInBuffer,
        uint dwInBufferLen,
        RemoteConfigCallback cbStateCallback,
        IntPtr pUserData);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_StopRemoteConfig(int lHandle);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_SendRemoteConfig(
        int lHandle,
        uint dwDataType,
        byte[] pSendBuf,
        uint dwBufSize);

    [DllImport("HCNetSDK.dll")]
    public static extern bool NET_DVR_GetDeviceAbility(
        int lUserID,
        uint dwAbilityType,
        byte[] pInBuf,
        uint dwInLength,
        byte[] pOutBuf,
        uint dwOutLength);
}

internal sealed record SdkCardWriteRequest(
    string CardNo,
    int[] Floors,
    short HomeFloor,
    string? Name,
    uint EmployeeNo,
    string? Password,
    byte CardType,
    bool ValidEnabled,
    DateTime? ValidBegin,
    DateTime? ValidEnd,
    bool Delete);

internal static class SdkCardHelper
{
    public static void SetCardNo(byte[] target, string cardNo)
    {
        Array.Clear(target);
        var bytes = Encoding.ASCII.GetBytes(cardNo);
        Array.Copy(bytes, target, Math.Min(bytes.Length, target.Length));
    }

    public static string ReadCardNo(byte[] source)
    {
        var end = Array.IndexOf(source, (byte)0);
        if (end < 0)
        {
            end = source.Length;
        }

        return Encoding.ASCII.GetString(source, 0, end).Trim();
    }

    public static IEnumerable<int> ReadFloorRights(byte[] byDoorRight, int maxFloor = 64)
    {
        var limit = Math.Min(byDoorRight.Length, maxFloor);
        if (UsesBytePerFloorEncoding(byDoorRight, limit))
        {
            for (var i = 0; i < limit; i++)
            {
                if (byDoorRight[i] != 0)
                {
                    yield return i + 1;
                }
            }

            yield break;
        }

        for (var floor = 1; floor <= maxFloor; floor++)
        {
            var bitIndex = floor - 1;
            if ((byDoorRight[bitIndex / 8] & (1 << (bitIndex % 8))) != 0)
            {
                yield return floor;
            }
        }
    }

    public static void SetFloorRights(byte[] byDoorRight, IEnumerable<int> floors, bool useBitmap = false)
    {
        Array.Clear(byDoorRight);
        foreach (var floor in floors)
        {
            if (floor < 1)
            {
                continue;
            }

            if (useBitmap)
            {
                var bitIndex = floor - 1;
                if (bitIndex / 8 >= byDoorRight.Length)
                {
                    continue;
                }

                byDoorRight[bitIndex / 8] |= (byte)(1 << (bitIndex % 8));
                continue;
            }

            if (floor > byDoorRight.Length)
            {
                continue;
            }

            byDoorRight[floor - 1] = 1;
        }
    }

    public static string DetectFloorEncoding(byte[] byDoorRight, int maxFloor)
    {
        var limit = Math.Min(byDoorRight.Length, maxFloor);
        return UsesBytePerFloorEncoding(byDoorRight, limit) ? "byte-per-floor" : "bitmap";
    }

    private static bool UsesBytePerFloorEncoding(byte[] byDoorRight, int limit)
    {
        for (var i = 0; i < limit; i++)
        {
            if (byDoorRight[i] > 1)
            {
                return false;
            }
        }

        return true;
    }

    public static HcNetSdkNative.NET_DVR_VALID_PERIOD_CFG CreateAlwaysValidPeriod()
    {
        var now = DateTime.Now;
        return new HcNetSdkNative.NET_DVR_VALID_PERIOD_CFG
        {
            byEnable = 0,
            byBeginTimeFlag = 0,
            byEnableTimeFlag = 0,
            byTimeDurationNo = 0,
            struBeginTime = new HcNetSdkNative.NET_DVR_TIME_EX
            {
                wYear = (ushort)now.Year,
                byMonth = (byte)now.Month,
                byDay = (byte)now.Day,
            },
            struEndTime = new HcNetSdkNative.NET_DVR_TIME_EX
            {
                wYear = 2037,
                byMonth = 12,
                byDay = 31,
            },
            byTimeType = 0,
            byRes2 = new byte[31],
        };
    }

    public static HcNetSdkNative.NET_DVR_CARD_CFG_V50 BuildCardConfig(SdkCardWriteRequest request)
    {
        var useBitmap = string.Equals(
            Environment.GetEnvironmentVariable("SDK_CARD_FLOOR_MODE"),
            "bitmap",
            StringComparison.OrdinalIgnoreCase);

        var modify =
            HcNetSdkNative.CardParamCardValid |
            HcNetSdkNative.CardParamCardType |
            HcNetSdkNative.CardParamDoorRight |
            HcNetSdkNative.CardParamFloorNumber;

        if (!string.IsNullOrWhiteSpace(request.Name))
        {
            modify |= HcNetSdkNative.CardParamName;
        }

        if (request.EmployeeNo > 0)
        {
            modify |= HcNetSdkNative.CardParamEmployeeNo;
        }

        if (!string.IsNullOrWhiteSpace(request.Password))
        {
            modify |= HcNetSdkNative.CardParamPassword;
        }

        if (request.ValidEnabled)
        {
            modify |= HcNetSdkNative.CardParamValid;
        }

        var card = CreateEmptyCard();
        card.dwModifyParamType = modify;
        card.byCardValid = request.Delete ? (byte)0 : (byte)1;
        card.byCardType = request.CardType;
        card.wFloorNumber = request.HomeFloor;
        card.dwEmployeeNo = request.EmployeeNo;
        card.struValid = request.ValidEnabled
            ? CreateValidPeriod(request.ValidBegin, request.ValidEnd)
            : CreateAlwaysValidPeriod();

        SetCardNo(card.byCardNo, request.CardNo);
        SetFloorRights(card.byDoorRight, request.Floors, useBitmap);

        if (!string.IsNullOrWhiteSpace(request.Name))
        {
            SetName(card.byName, request.Name);
        }

        if (!string.IsNullOrWhiteSpace(request.Password))
        {
            SetPassword(card.byCardPassword, request.Password);
        }

        return card;
    }

    public static HcNetSdkNative.NET_DVR_CARD_CFG_V50 CreateEmptyCard() =>
        new()
        {
            dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_CARD_CFG_V50>(),
            byCardNo = new byte[HcNetSdkNative.AcsCardNoLen],
            byDoorRight = new byte[HcNetSdkNative.MaxDoorNum256],
            struValid = CreateAlwaysValidPeriod(),
            byBelongGroup = new byte[HcNetSdkNative.MaxGroupNum128],
            byCardPassword = new byte[HcNetSdkNative.CardPasswordLen],
            wCardRightPlan = new byte[HcNetSdkNative.MaxDoorNum256 * HcNetSdkNative.MaxCardRightPlanNum * 2],
            byName = new byte[HcNetSdkNative.NameLen],
            byRes2 = new byte[2],
            byLockCode = new byte[HcNetSdkNative.MaxLockCodeLen],
            byRoomCode = new byte[HcNetSdkNative.MaxDoorCodeLen],
            byRes3 = new byte[51],
            bySIMNum = new byte[HcNetSdkNative.NameLen],
        };

    public static HcNetSdkNative.NET_DVR_VALID_PERIOD_CFG CreateValidPeriod(
        DateTime? begin,
        DateTime? end)
    {
        var start = begin ?? DateTime.Now;
        var stop = end ?? new DateTime(2037, 12, 31);
        return new HcNetSdkNative.NET_DVR_VALID_PERIOD_CFG
        {
            byEnable = 1,
            struBeginTime = ToTimeEx(start),
            struEndTime = ToTimeEx(stop),
            byRes2 = new byte[31],
        };
    }

    private static HcNetSdkNative.NET_DVR_TIME_EX ToTimeEx(DateTime value) =>
        new()
        {
            wYear = (ushort)value.Year,
            byMonth = (byte)value.Month,
            byDay = (byte)value.Day,
            byHour = (byte)value.Hour,
            byMinute = (byte)value.Minute,
            bySecond = (byte)value.Second,
        };

    public static HcNetSdkNative.NET_DVR_CARD_CFG_COND CreateCond(uint cardNum) =>
        new()
        {
            dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_CARD_CFG_COND>(),
            dwCardNum = cardNum,
            byCheckCardNo = 1,
            byRes2 = new byte[2],
            byRes3 = new byte[20],
        };

    public static string FormatFloorList(byte[] byDoorRight, int maxFloor)
    {
        var items = ReadFloorRights(byDoorRight, maxFloor).ToList();
        if (items.Count == 0)
        {
            return "(無)";
        }

        if (items.Count > 24)
        {
            return $"{string.Join(", ", items.Take(12))} ... {string.Join(", ", items.TakeLast(3))} (共 {items.Count} 層)";
        }

        return string.Join(", ", items);
    }

    public static string FormatCardType(byte cardType) => cardType switch
    {
        1 => "普通卡",
        2 => "殘障卡",
        3 => "黑名單卡",
        4 => "巡更卡",
        5 => "脅迫卡",
        6 => "超級卡",
        7 => "訪客卡",
        _ => "其他",
    };

    public static string ReadName(byte[] source)
    {
        var end = Array.IndexOf(source, (byte)0);
        if (end < 0)
        {
            end = source.Length;
        }

        if (end == 0)
        {
            return "(未設定)";
        }

        try
        {
            return Encoding.GetEncoding(936).GetString(source, 0, end).Trim();
        }
        catch
        {
            return Encoding.UTF8.GetString(source, 0, end).Trim();
        }
    }

    public static void SetName(byte[] target, string name)
    {
        Array.Clear(target);
        try
        {
            var bytes = Encoding.GetEncoding(936).GetBytes(name);
            Array.Copy(bytes, target, Math.Min(bytes.Length, target.Length));
        }
        catch
        {
            var bytes = Encoding.UTF8.GetBytes(name);
            Array.Copy(bytes, target, Math.Min(bytes.Length, target.Length));
        }
    }

    public static void SetPassword(byte[] target, string password)
    {
        Array.Clear(target);
        var bytes = Encoding.ASCII.GetBytes(password);
        Array.Copy(bytes, target, Math.Min(bytes.Length, target.Length));
    }

    public static string FormatPassword(byte[] source) =>
        source.Any(b => b != 0) ? "****" : "(未設定)";

    public static string FormatValidPeriod(HcNetSdkNative.NET_DVR_VALID_PERIOD_CFG valid)
    {
        if (valid.byEnable == 0)
        {
            return "未啟用（永久有效）";
        }

        var begin = $"{valid.struBeginTime.wYear:D4}-{valid.struBeginTime.byMonth:D2}-{valid.struBeginTime.byDay:D2} " +
                    $"{valid.struBeginTime.byHour:D2}:{valid.struBeginTime.byMinute:D2}:{valid.struBeginTime.bySecond:D2}";
        var end = $"{valid.struEndTime.wYear:D4}-{valid.struEndTime.byMonth:D2}-{valid.struEndTime.byDay:D2} " +
                  $"{valid.struEndTime.byHour:D2}:{valid.struEndTime.byMinute:D2}:{valid.struEndTime.bySecond:D2}";
        return $"{begin} ~ {end}";
    }
}

internal static class SdkAbilityHelper
{
    public static string? QueryAcsAbilityXml(int userId)
    {
        var input = Encoding.UTF8.GetBytes("<AcsAbility version='2.0'></AcsAbility>");
        var output = new byte[256 * 1024];
        if (!HcNetSdkNative.NET_DVR_GetDeviceAbility(
                userId,
                HcNetSdkNative.AcsAbility,
                input,
                (uint)input.Length,
                output,
                (uint)output.Length))
        {
            return null;
        }

        var length = Array.IndexOf(output, (byte)0);
        if (length < 0)
        {
            length = output.Length;
        }

        return Encoding.UTF8.GetString(output, 0, length).Trim('\0');
    }
}

internal static class SdkGatewayHelper
{
    public static string CommandName(uint command) => command switch
    {
        HcNetSdkNative.GatewayClose => "關閉 (0)",
        HcNetSdkNative.GatewayOpen => "開啟 (1)",
        HcNetSdkNative.GatewayAlwaysOpen => "常開 (2)",
        HcNetSdkNative.GatewayAlwaysClose => "常閉 (3)",
        HcNetSdkNative.GatewayRecovery => "恢復 (4)",
        HcNetSdkNative.GatewayVisitorCall => "訪客呼梯 (5)",
        HcNetSdkNative.GatewayResidentCall => "住戶呼梯 (6)",
        _ => $"自訂 ({command})",
    };
}

internal static class SdkErrorHelper
{
    public static string Explain(uint code) => code switch
    {
        1 => "使用者名稱或密碼錯誤",
        7 => "連線設備失敗（設備離線或網路不通）",
        109 => "載入報警元件失敗（請確認 HCNetSDKCom\\HCAlarm.dll 已複製）",
        1924 => "佈防資源已滿",
        _ => "請查閱 HCNetSDK 錯誤碼手冊",
    };
}

internal sealed class SdkDeviceSession : IDisposable
{
    private IntPtr _deviceInfoPtr = IntPtr.Zero;
    private bool _initialized;

    public int UserId { get; private set; } = -1;

    public bool Connect(string host, int port, string user, string pass)
    {
        if (!HcNetSdkNative.NET_DVR_Init())
        {
            Console.WriteLine($"Init 失敗, error={HcNetSdkNative.NET_DVR_GetLastError()}");
            return false;
        }

        _initialized = true;
        HcNetSdkNative.NET_DVR_SetConnectTime(2000, 1);
        HcNetSdkNative.NET_DVR_SetReconnect(10000, true);

        var loginInfo = new HcNetSdkNative.NET_DVR_USER_LOGIN_INFO
        {
            sDeviceAddress = host,
            byUseTransport = 0,
            wPort = (ushort)port,
            sUserName = user,
            sPassword = pass,
            cbLoginResult = IntPtr.Zero,
            pUser = IntPtr.Zero,
            bUseAsynLogin = 0,
            byProxyType = 0,
            byUseUTCTime = 0,
            byLoginMode = 0,
            byHttps = 0,
            iProxyID = 0,
            byVerifyMode = 0,
            byRes3 = new byte[119],
        };

        _deviceInfoPtr = Marshal.AllocHGlobal(512);
        Marshal.Copy(new byte[512], 0, _deviceInfoPtr, 512);
        UserId = HcNetSdkNative.NET_DVR_Login_V40(ref loginInfo, _deviceInfoPtr);
        if (UserId < 0)
        {
            Console.WriteLine($"登入失敗 {host}:{port}, error={HcNetSdkNative.NET_DVR_GetLastError()}");
            return false;
        }

        return true;
    }

    public void Dispose()
    {
        if (UserId >= 0)
        {
            HcNetSdkNative.NET_DVR_Logout(UserId);
            UserId = -1;
        }

        if (_deviceInfoPtr != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_deviceInfoPtr);
            _deviceInfoPtr = IntPtr.Zero;
        }

        if (_initialized)
        {
            HcNetSdkNative.NET_DVR_Cleanup();
            _initialized = false;
        }
    }
}

internal static class SdkEnv
{
    public static (string Host, int Port, string User, string Pass) ReadDeviceCredentials(
        string defaultHost = "192.168.6.100",
        int defaultPort = 8000,
        string defaultUser = "admin",
        string defaultPass = "")
    {
        var host = Environment.GetEnvironmentVariable("SDK_DEVICE_HOST") ?? defaultHost;
        var port = int.TryParse(Environment.GetEnvironmentVariable("SDK_DEVICE_PORT"), out var parsedPort)
            ? parsedPort
            : defaultPort;
        var user = Environment.GetEnvironmentVariable("SDK_DEVICE_USER") ?? defaultUser;
        var pass = Environment.GetEnvironmentVariable("SDK_DEVICE_PASS") ?? defaultPass;
        return (host, port, user, pass);
    }

    public static bool RequirePassword(string pass)
    {
        if (!string.IsNullOrWhiteSpace(pass))
        {
            return true;
        }

        Console.Error.WriteLine("請設定 SDK_DEVICE_PASS 或修改 device.config.ps1。");
        return false;
    }
}
