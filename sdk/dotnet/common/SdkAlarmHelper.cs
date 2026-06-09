using System.Runtime.InteropServices;
using System.Text;

namespace HcNetSdkCommon;

internal readonly record struct AcsAlarmEvent(
    uint Major,
    uint Minor,
    uint DoorNo,
    string CardNo);

internal static class SdkAlarmHelper
{
    private const int AcsEventInfoOffset = 196;
    private const int DoorNoOffsetInEventInfo = 44;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct NET_DVR_ACS_EVENT_INFO_HEAD
    {
        public uint dwSize;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = HcNetSdkNative.AcsCardNoLen)]
        public byte[] byCardNo;

        public byte byCardType;
        public byte byAllowListNo;
        public byte byReportChannel;
        public byte byCardReaderKind;
        public uint dwCardReaderNo;
        public uint dwDoorNo;
    }

    public static bool TryParse(IntPtr pAlarmInfo, uint bufLen, out AcsAlarmEvent evt)
    {
        evt = default;
        if (pAlarmInfo == IntPtr.Zero || bufLen < 12)
        {
            return false;
        }

        var major = (uint)Marshal.ReadInt32(pAlarmInfo, 4);
        var minor = (uint)Marshal.ReadInt32(pAlarmInfo, 8);
        var doorNo = 0u;
        var cardNo = string.Empty;

        var eventInfoOffset = AcsEventInfoOffset;
        var required = eventInfoOffset + Marshal.SizeOf<NET_DVR_ACS_EVENT_INFO_HEAD>();
        if (bufLen >= required)
        {
            var head = Marshal.PtrToStructure<NET_DVR_ACS_EVENT_INFO_HEAD>(
                IntPtr.Add(pAlarmInfo, eventInfoOffset));
            doorNo = head.dwDoorNo;
            cardNo = SdkCardHelper.ReadCardNo(head.byCardNo);
        }
        else if (bufLen >= eventInfoOffset + DoorNoOffsetInEventInfo + 4)
        {
            doorNo = (uint)Marshal.ReadInt32(pAlarmInfo, eventInfoOffset + DoorNoOffsetInEventInfo);
        }

        evt = new AcsAlarmEvent(major, minor, doorNo, cardNo);
        return true;
    }

    public static string FormatEventLine(AcsAlarmEvent evt)
    {
        var line = AcsEventNames.Format(evt.Major, evt.Minor);
        if (evt.DoorNo > 0)
        {
            line += $" | 樓層={evt.DoorNo}";
        }

        if (!string.IsNullOrEmpty(evt.CardNo) && evt.CardNo != "0")
        {
            line += $" | 卡號={evt.CardNo}";
        }

        return line;
    }
}
