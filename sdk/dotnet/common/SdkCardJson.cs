using System.Text.Json;
using System.Text.Json.Serialization;

namespace HcNetSdkCommon;

internal static class SdkCardJson
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static object ToCardObject(HcNetSdkNative.NET_DVR_CARD_CFG_V50 card, int maxFloor)
    {
        var floors = SdkCardHelper.ReadFloorRights(card.byDoorRight, maxFloor).ToList();
        return new
        {
            cardNo = SdkCardHelper.ReadCardNo(card.byCardNo),
            valid = card.byCardValid != 0,
            cardType = card.byCardType,
            cardTypeName = SdkCardHelper.FormatCardType(card.byCardType),
            name = SdkCardHelper.ReadName(card.byName),
            employeeNo = card.dwEmployeeNo,
            passwordMasked = SdkCardHelper.FormatPassword(card.byCardPassword),
            validPeriod = SdkCardHelper.FormatValidPeriod(card.struValid),
            homeFloor = card.wFloorNumber,
            floors,
            floorEncoding = SdkCardHelper.DetectFloorEncoding(card.byDoorRight, maxFloor),
            doorRightRaw = SdkFloorHelper.FormatDoorRightRaw(card.byDoorRight, 16),
            rightPlans = SdkFloorHelper.FormatRightPlans(card.wCardRightPlan),
        };
    }

    public static string Serialize(object value) =>
        JsonSerializer.Serialize(value, JsonOptions);
}
