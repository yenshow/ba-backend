using System.Runtime.InteropServices;
using System.Text;

namespace HcNetSdkCommon;

internal sealed record SdkDoorInfo(
    int DoorIndex,
    string Name,
    byte OpenDuration,
    byte LadderControlDelayTime);

internal static class SdkDoorService
{
    public static int QueryMaxDoor(int userId) => SdkCardService.QueryMaxFloor(userId);

    public static (bool Ok, List<SdkDoorInfo> Doors, string Error) ListDoors(int userId, int? limit = null)
    {
        var maxDoor = limit is > 0 and var capped ? Math.Min(capped, QueryMaxDoor(userId)) : QueryMaxDoor(userId);
        var doors = new List<SdkDoorInfo>();

        for (var doorIndex = 1; doorIndex <= maxDoor; doorIndex++)
        {
            var (ok, door, error) = GetDoor(userId, doorIndex);
            if (!ok)
            {
                if (doors.Count == 0)
                {
                    return (false, doors, error);
                }

                break;
            }

            doors.Add(door);
        }

        if (doors.Count == 0)
        {
            return (false, doors, "未取得任何門／樓層參數");
        }

        return (true, doors, string.Empty);
    }

    public static (bool Ok, SdkDoorInfo Door, string Error) GetDoor(int userId, int doorIndex)
    {
        var (ok, cfg, error) = GetDoorConfig(userId, doorIndex);
        if (!ok)
        {
            return (false, default!, error);
        }

        return (true, ToDoorInfo(doorIndex, cfg), string.Empty);
    }

    public static (bool Ok, string Error) SetDoorName(int userId, int doorIndex, string name) =>
        SetDoor(userId, doorIndex, name, null);

    public static (bool Ok, string Error) SetDoor(
        int userId,
        int doorIndex,
        string? name,
        byte? openDuration)
    {
        if (name == null && openDuration == null)
        {
            return (false, "請提供 name 或 openDuration");
        }

        var (ok, cfg, error) = GetDoorConfig(userId, doorIndex);
        if (!ok)
        {
            return (false, error);
        }

        if (name != null)
        {
            SetDoorNameBytes(cfg.byDoorName, name);
        }

        if (openDuration.HasValue)
        {
            cfg.byOpenDuration = openDuration.Value;
        }

        return SetDoorConfig(userId, doorIndex, cfg);
    }

    private static (bool Ok, HcNetSdkNative.NET_DVR_DOOR_CFG Cfg, string Error) GetDoorConfig(
        int userId,
        int doorIndex)
    {
        if (doorIndex < 1)
        {
            return (false, default, "doorIndex 須 >= 1");
        }

        var size = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_DOOR_CFG>();
        var buffer = new byte[size];
        var bytesReturned = 0u;

        if (!HcNetSdkNative.NET_DVR_GetDVRConfig(
                userId,
                HcNetSdkNative.NetDvrGetDoorCfg,
                doorIndex,
                buffer,
                size,
                ref bytesReturned))
        {
            var err = HcNetSdkNative.NET_DVR_GetLastError();
            return (false, default, $"GetDVRConfig(DOOR_CFG) 失敗 door={doorIndex}, error={err} ({SdkErrorHelper.Explain(err)})");
        }

        var cfg = SdkMarshal.BytesToStruct<HcNetSdkNative.NET_DVR_DOOR_CFG>(buffer);
        return (true, cfg, string.Empty);
    }

    private static (bool Ok, string Error) SetDoorConfig(
        int userId,
        int doorIndex,
        HcNetSdkNative.NET_DVR_DOOR_CFG cfg)
    {
        cfg.dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_DOOR_CFG>();
        var buffer = SdkMarshal.StructToBytes(cfg);

        if (!HcNetSdkNative.NET_DVR_SetDVRConfig(
                userId,
                HcNetSdkNative.NetDvrSetDoorCfg,
                doorIndex,
                buffer,
                cfg.dwSize))
        {
            var err = HcNetSdkNative.NET_DVR_GetLastError();
            return (false, $"SetDVRConfig(DOOR_CFG) 失敗 door={doorIndex}, error={err} ({SdkErrorHelper.Explain(err)})");
        }

        return (true, string.Empty);
    }

    private static SdkDoorInfo ToDoorInfo(int doorIndex, HcNetSdkNative.NET_DVR_DOOR_CFG cfg) =>
        new(
            DoorIndex: doorIndex,
            Name: ReadDoorName(cfg.byDoorName),
            OpenDuration: cfg.byOpenDuration,
            LadderControlDelayTime: cfg.byLadderControlDelayTime);

    public static string ReadDoorName(byte[] source)
    {
        var end = Array.IndexOf(source, (byte)0);
        if (end < 0)
        {
            end = source.Length;
        }

        if (end == 0)
        {
            return string.Empty;
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

    private static void SetDoorNameBytes(byte[] target, string name)
    {
        Array.Clear(target);
        if (string.IsNullOrEmpty(name))
        {
            return;
        }

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
}
