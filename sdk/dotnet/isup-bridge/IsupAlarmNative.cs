using System.Runtime.InteropServices;
using static QuickNV.HikvisionISUPSDK.Defines;

internal static class IsupAlarmNative
{
    private const string Dll = "HCISUPAlarm.dll";

    public const int AlarmUnknown = 0;
    public const int AlarmGeneric = 1;
    public const int AlarmGps = 4;
    public const int AlarmAcs = 11;
    public const int AlarmIsapi = 13;
    public const int AlarmQrCode = 20;

    public const byte ProtocolTcp = 0;
    public const byte ProtocolUdp = 1;
    public const byte ProtocolMqtt = 2;

    public const byte IsapiXml = 1;
    public const byte IsapiJson = 2;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public delegate bool EHomeMsgCallBack(int handle, IntPtr alarmMsg, IntPtr user);

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_EHOME_ALARM_LISTEN_PARAM
    {
        public NET_EHOME_IPADDRESS struAddress;
        public EHomeMsgCallBack fnMsgCb;
        public IntPtr pUserData;
        public byte byProtocolType;
        public byte byUseCmsPort;
        public byte byUseThreadPool;
        public byte byRes1;
        public int dwKeepAliveSec;
        public int dwTimeOutCount;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 20)]
        public byte[] byRes;

        public void Init()
        {
            struAddress.Init();
            byRes = new byte[20];
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_EHOME_ALARM_MSG
    {
        public uint dwAlarmType;
        public IntPtr pAlarmInfo;
        public uint dwAlarmInfoLen;
        public IntPtr pXmlBuf;
        public uint dwXmlBufLen;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 12)]
        public byte[] sSerialNumber;

        public IntPtr pHttpUrl;
        public uint dwHttpUrlLen;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 12)]
        public byte[] byRes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NET_EHOME_ALARM_ISAPI_INFO
    {
        public IntPtr pAlarmData;
        public uint dwAlarmDataLen;
        public byte byDataType;
        public byte byPicturesNumber;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public byte[] byRes;

        public IntPtr pPicPackData;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        public byte[] byRes1;
    }

    [DllImport(Dll, EntryPoint = "NET_EALARM_Init", CallingConvention = CallingConvention.StdCall)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Init();

    [DllImport(Dll, EntryPoint = "NET_EALARM_Fini", CallingConvention = CallingConvention.StdCall)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Fini();

    [DllImport(Dll, EntryPoint = "NET_EALARM_GetLastError", CallingConvention = CallingConvention.StdCall)]
    public static extern int GetLastError();

    [DllImport(Dll, EntryPoint = "NET_EALARM_StartListen", CallingConvention = CallingConvention.StdCall)]
    public static extern int StartListen(ref NET_EHOME_ALARM_LISTEN_PARAM param);

    [DllImport(Dll, EntryPoint = "NET_EALARM_StopListen", CallingConvention = CallingConvention.StdCall)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool StopListen(int listenHandle);

    [DllImport(Dll, EntryPoint = "NET_EALARM_SetDeviceSessionKey", CallingConvention = CallingConvention.StdCall)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetDeviceSessionKey(ref NET_EHOME_DEV_SESSIONKEY key);

    public static string AlarmTypeName(int alarmType)
    {
        return alarmType switch
        {
            AlarmGeneric => "EHOME_ALARM",
            AlarmGps => "GPS",
            AlarmAcs => "ACS",
            AlarmIsapi => "ISAPI",
            AlarmQrCode => "QRCODE",
            _ => "TYPE_" + alarmType,
        };
    }
}
