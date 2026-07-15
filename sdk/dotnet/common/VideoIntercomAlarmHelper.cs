using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace HcNetSdkCommon;

internal readonly record struct VideoIntercomEvent(
    string Kind,
    byte EventOrAlarmType,
    string TypeName,
    string DeviceNumber,
    string Time,
    uint IotChannelNo,
    string? Detail);

internal readonly record struct IsapiAlarmEvent(
    byte DataType,
    string DataTypeName,
    uint DataLen,
    string? Text,
    string? Summary);

internal static class VideoIntercomAlarmHelper
{
    public const int CommUploadVideoIntercomEvent = 0x1132;
    public const int CommAlarmVideoIntercom = 0x1133;
    public const int CommIsapiAlarm = 0x6009;

    private const int MaxDevNumberLen = 32;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct NET_DVR_TIME_EX
    {
        public ushort wYear;
        public byte byMonth;
        public byte byDay;
        public byte byHour;
        public byte byMinute;
        public byte bySecond;
        public byte byRes;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct NET_DVR_VIDEO_INTERCOM_EVENT
    {
        public uint dwSize;
        public NET_DVR_TIME_EX struTime;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxDevNumberLen)]
        public byte[] byDevNumber;

        public byte byEventType;
        public byte byPicTransType;
        public byte byRes1_0;
        public byte byRes1_1;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)]
        public byte[] uEventInfo;

        public uint dwIOTChannelNo;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 252)]
        public byte[] byRes2;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct NET_DVR_VIDEO_INTERCOM_ALARM
    {
        public uint dwSize;
        public NET_DVR_TIME_EX struTime;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MaxDevNumberLen)]
        public byte[] byDevNumber;

        public byte byAlarmType;
        public byte byRes1_0;
        public byte byRes1_1;
        public byte byRes1_2;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)]
        public byte[] uAlarmInfo;

        public ushort wLockID;
        public byte byRes3_0;
        public byte byRes3_1;
        public uint dwIOTChannelNo;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 248)]
        public byte[] byRes2;
    }

    /// <summary>
    /// COMM_ISAPI_ALARM (0x6009) — 結構內為指標，需解引用 pAlarmData 才是實際 XML/JSON。
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct NET_DVR_ALARM_ISAPI_INFO
    {
        public IntPtr pAlarmData;
        public uint dwAlarmDataLen;
        public byte byDataType;
        public byte byPicturesNumber;
        public byte byRes0;
        public byte byRes1;
        public IntPtr pPicPackData;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        public byte[] byRes2;
    }

    public static bool TryParse(
        int command,
        IntPtr pAlarmInfo,
        uint bufLen,
        out VideoIntercomEvent evt)
    {
        evt = default;
        if (pAlarmInfo == IntPtr.Zero || bufLen < 8)
        {
            return false;
        }

        return command switch
        {
            CommUploadVideoIntercomEvent => TryParseEvent(pAlarmInfo, bufLen, out evt),
            CommAlarmVideoIntercom => TryParseAlarm(pAlarmInfo, bufLen, out evt),
            _ => false,
        };
    }

    public static bool TryParseIsapiAlarm(
        IntPtr pAlarmInfo,
        uint bufLen,
        out IsapiAlarmEvent evt)
    {
        evt = default;
        if (pAlarmInfo == IntPtr.Zero || bufLen < (uint)Marshal.SizeOf<NET_DVR_ALARM_ISAPI_INFO>())
        {
            return false;
        }

        var info = Marshal.PtrToStructure<NET_DVR_ALARM_ISAPI_INFO>(pAlarmInfo);
        var dataTypeName = info.byDataType switch
        {
            1 => "xml",
            2 => "json",
            _ => $"type_{info.byDataType}",
        };

        string? text = null;
        if (info.pAlarmData != IntPtr.Zero && info.dwAlarmDataLen > 0 && info.dwAlarmDataLen < 4 * 1024 * 1024)
        {
            var bytes = new byte[info.dwAlarmDataLen];
            Marshal.Copy(info.pAlarmData, bytes, 0, (int)info.dwAlarmDataLen);
            text = DecodeText(bytes);
        }

        evt = new IsapiAlarmEvent(
            info.byDataType,
            dataTypeName,
            info.dwAlarmDataLen,
            text,
            SummarizeIsapiPayload(text));
        return true;
    }

    private static bool TryParseEvent(IntPtr ptr, uint bufLen, out VideoIntercomEvent evt)
    {
        evt = default;
        if (bufLen < 48)
        {
            return false;
        }

        var raw = Marshal.PtrToStructure<NET_DVR_VIDEO_INTERCOM_EVENT>(ptr);
        var type = raw.byEventType;
        evt = new VideoIntercomEvent(
            "intercom_event",
            type,
            DescribeEventType(type),
            ReadAnsi(raw.byDevNumber),
            FormatTime(raw.struTime),
            raw.dwIOTChannelNo,
            null);
        return true;
    }

    private static bool TryParseAlarm(IntPtr ptr, uint bufLen, out VideoIntercomEvent evt)
    {
        evt = default;
        if (bufLen < 48)
        {
            return false;
        }

        var raw = Marshal.PtrToStructure<NET_DVR_VIDEO_INTERCOM_ALARM>(ptr);
        var type = raw.byAlarmType;
        var detail = raw.wLockID > 0 ? $"lockId={raw.wLockID}" : null;
        evt = new VideoIntercomEvent(
            "intercom_alarm",
            type,
            DescribeAlarmType(type),
            ReadAnsi(raw.byDevNumber),
            FormatTime(raw.struTime),
            raw.dwIOTChannelNo,
            detail);
        return true;
    }

    private static string DescribeEventType(byte type) => type switch
    {
        1 => "unlock_record",
        2 => "noticedata_receipt",
        3 => "auth_info",
        4 => "upload_plate",
        5 => "invalid_card",
        6 => "send_card",
        7 => "mask_detect",
        8 => "magnetic_door_status",
        _ => $"event_type_{type}",
    };

    private static string DescribeAlarmType(byte type) => type switch
    {
        1 => "zone_alarm",
        2 => "tamper",
        3 => "duress",
        4 => "password_over_times",
        5 => "door_not_open",
        6 => "door_not_closed",
        7 => "panic",
        8 => "intercom_alarm",
        17 => "doorbell_ringing",
        18 => "dismiss_incoming_call",
        _ => $"alarm_type_{type}",
    };

    private static string FormatTime(NET_DVR_TIME_EX t)
    {
        if (t.wYear == 0)
        {
            return string.Empty;
        }

        return $"{t.wYear:D4}-{t.byMonth:D2}-{t.byDay:D2}T{t.byHour:D2}:{t.byMinute:D2}:{t.bySecond:D2}";
    }

    private static string ReadAnsi(byte[]? bytes)
    {
        if (bytes == null || bytes.Length == 0)
        {
            return string.Empty;
        }

        var end = Array.IndexOf(bytes, (byte)0);
        var len = end >= 0 ? end : bytes.Length;
        if (len <= 0)
        {
            return string.Empty;
        }

        try
        {
            return Encoding.GetEncoding(936).GetString(bytes, 0, len).Trim();
        }
        catch
        {
            return Encoding.UTF8.GetString(bytes, 0, len).Trim();
        }
    }

    private static string DecodeText(byte[] bytes)
    {
        if (bytes.Length == 0)
        {
            return string.Empty;
        }

        var end = Array.IndexOf(bytes, (byte)0);
        var len = end >= 0 ? end : bytes.Length;
        var utf8 = Encoding.UTF8.GetString(bytes, 0, len);
        if (!utf8.Contains('\uFFFD'))
        {
            return utf8.Trim();
        }

        try
        {
            return Encoding.GetEncoding(936).GetString(bytes, 0, len).Trim();
        }
        catch
        {
            return utf8.Trim();
        }
    }

    private static string? SummarizeIsapiPayload(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var eventType = MatchJsonField(text, "eventType")
            ?? MatchXmlTag(text, "eventType")
            ?? MatchJsonField(text, "cmdType")
            ?? MatchJsonField(text, "status");
        var ipAddress = MatchJsonField(text, "ipAddress")
            ?? MatchXmlTag(text, "ipAddress");
        var deviceName = MatchJsonField(text, "deviceName")
            ?? MatchXmlTag(text, "deviceName");
        var channel = MatchJsonField(text, "channelID");

        var parts = new List<string>();
        if (!string.IsNullOrEmpty(eventType)) parts.Add($"eventType={eventType}");
        if (!string.IsNullOrEmpty(deviceName)) parts.Add($"device={deviceName}");
        if (!string.IsNullOrEmpty(ipAddress)) parts.Add($"ip={ipAddress}");
        if (!string.IsNullOrEmpty(channel)) parts.Add($"ch={channel}");

        if (parts.Count > 0)
        {
            return string.Join(", ", parts);
        }

        var trimmed = text.Trim();
        return trimmed.Length > 120 ? trimmed[..120] + "…" : trimmed;
    }

    private static string? MatchJsonField(string text, string field)
    {
        var m = Regex.Match(
            text,
            $"\"{field}\"\\s*:\\s*\"([^\"]+)\"",
            RegexOptions.IgnoreCase);
        if (m.Success)
        {
            return m.Groups[1].Value;
        }

        m = Regex.Match(
            text,
            $"\"{field}\"\\s*:\\s*([^,\\}}\\s]+)",
            RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value.Trim('"') : null;
    }

    private static string? MatchXmlTag(string text, string tag)
    {
        var m = Regex.Match(
            text,
            $"<{tag}>([^<]+)</{tag}>",
            RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    public static string HexPreview(IntPtr ptr, uint bufLen, int maxBytes = 64)
    {
        if (ptr == IntPtr.Zero || bufLen == 0)
        {
            return string.Empty;
        }

        var take = (int)Math.Min(bufLen, (uint)maxBytes);
        var buffer = new byte[take];
        Marshal.Copy(ptr, buffer, 0, take);
        return Convert.ToHexString(buffer);
    }
}
