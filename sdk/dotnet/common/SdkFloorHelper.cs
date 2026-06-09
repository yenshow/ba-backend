using System.Text;
using System.Text.RegularExpressions;

namespace HcNetSdkCommon;

internal static class SdkFloorHelper
{
    public static int? ParseMaxDoorNoFromAbilityXml(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml))
        {
            return null;
        }

        var patterns = new[]
        {
            @"<doorNo[^>]*max=""(\d+)""",
            @"<doorNo[^>]*>\s*(\d+)\s*</doorNo>",
            @"<DoorNo[^>]*max=""(\d+)""",
            @"<maxDoorNo>\s*(\d+)\s*</maxDoorNo>",
            @"<doorNum>\s*(\d+)\s*</doorNum>",
        };

        foreach (var pattern in patterns)
        {
            var match = Regex.Match(xml, pattern, RegexOptions.IgnoreCase);
            if (match.Success && int.TryParse(match.Groups[1].Value, out var value) && value > 0)
            {
                return value;
            }
        }

        return null;
    }

    public static string FormatRightPlans(byte[] wCardRightPlan, int maxDoors = 16)
    {
        var parts = new List<string>();
        for (var door = 0; door < maxDoors; door++)
        {
            for (var plan = 0; plan < HcNetSdkNative.MaxCardRightPlanNum; plan++)
            {
                var offset = (door * HcNetSdkNative.MaxCardRightPlanNum + plan) * 2;
                if (offset + 1 >= wCardRightPlan.Length)
                {
                    break;
                }

                var value = BitConverter.ToUInt16(wCardRightPlan, offset);
                if (value != 0)
                {
                    parts.Add($"F{door + 1}:P{plan + 1}={value}");
                }
            }
        }

        return parts.Count > 0 ? string.Join(", ", parts) : "(無)";
    }

    public static string FormatDoorRightRaw(byte[] byDoorRight, int bytes = 16)
    {
        var length = Math.Min(bytes, byDoorRight.Length);
        var sb = new StringBuilder();
        for (var i = 0; i < length; i++)
        {
            if (i > 0)
            {
                sb.Append(' ');
            }

            sb.Append(byDoorRight[i].ToString("X2"));
        }

        return sb.ToString();
    }
}
