namespace HcNetSdkCommon;

internal static class AcsEventNames
{
    private static readonly Dictionary<(uint Major, uint Minor), string> Names = new()
    {
        [(0x3, 0x400)] = "遠端開門",
        [(0x3, 0x401)] = "遠端關門",
        [(0x3, 0x402)] = "遠端常開",
        [(0x3, 0x403)] = "遠端常閉",
        [(0x5, 0x01)] = "合法卡通行",
        [(0x5, 0x5f)] = "呼梯繼電器斷開",
        [(0x5, 0x60)] = "呼梯繼電器閉合",
    };

    public static string Format(uint major, uint minor)
    {
        if (Names.TryGetValue((major, minor), out var name))
        {
            return $"{MajorName(major)} / {name} (0x{major:x}/0x{minor:x})";
        }

        return $"{MajorName(major)} / Minor=0x{minor:x} (0x{major:x}/0x{minor:x})";
    }

    private static string MajorName(uint major) => major switch
    {
        0x3 => "操作",
        0x5 => "事件",
        _ => $"Major=0x{major:x}",
    };
}
