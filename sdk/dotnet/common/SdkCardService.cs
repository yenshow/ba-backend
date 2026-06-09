using System.Runtime.InteropServices;

namespace HcNetSdkCommon;

internal enum SdkCardAction
{
    List,
    Get,
    Create,
    Update,
    Delete,
}

internal static class SdkCardService
{
    public static SdkCardAction ParseAction(string? raw) => raw?.Trim().ToLowerInvariant() switch
    {
        "list" or "read-all" or "all" => SdkCardAction.List,
        "get" or "read" => SdkCardAction.Get,
        "create" or "add" or "set" => SdkCardAction.Create,
        "update" or "upsert" => SdkCardAction.Update,
        "delete" or "remove" => SdkCardAction.Delete,
        _ => SdkCardAction.List,
    };

    public static int QueryMaxFloor(int userId)
    {
        var xml = SdkAbilityHelper.QueryAcsAbilityXml(userId);
        if (string.IsNullOrWhiteSpace(xml))
        {
            return 64;
        }

        return SdkFloorHelper.ParseMaxDoorNoFromAbilityXml(xml) ?? 64;
    }

    public static (bool Ok, List<HcNetSdkNative.NET_DVR_CARD_CFG_V50> Cards, string Error) GetCards(
        int userId,
        SdkCardAction action,
        string cardNo)
    {
        var cards = new List<HcNetSdkNative.NET_DVR_CARD_CFG_V50>();
        var callbackError = string.Empty;

        var querySingle = action == SdkCardAction.Get;
        if (querySingle && string.IsNullOrWhiteSpace(cardNo))
        {
            return (false, cards, "get 操作請設定 CardNo");
        }

        var doneEvent = new ManualResetEventSlim(false);
        HcNetSdkNative.RemoteConfigCallback callback = (dwType, lpBuffer, dwBufLen, _) =>
        {
            if (dwType == HcNetSdkNative.NetSdkCallbackTypeData && lpBuffer != IntPtr.Zero)
            {
                var cardSize = Marshal.SizeOf<HcNetSdkNative.NET_DVR_CARD_CFG_V50>();
                if (dwBufLen >= cardSize)
                {
                    var bytes = new byte[cardSize];
                    Marshal.Copy(lpBuffer, bytes, 0, cardSize);
                    cards.Add(SdkMarshal.BytesToStruct<HcNetSdkNative.NET_DVR_CARD_CFG_V50>(bytes));
                }

                return;
            }

            if (dwType != HcNetSdkNative.NetSdkCallbackTypeStatus || lpBuffer == IntPtr.Zero)
            {
                return;
            }

            var status = (uint)Marshal.ReadInt32(lpBuffer);
            switch (status)
            {
                case HcNetSdkNative.NetSdkCallbackStatusSuccess:
                    doneEvent.Set();
                    break;
                case HcNetSdkNative.NetSdkCallbackStatusFailed:
                    callbackError = dwBufLen >= 8
                        ? $"error={Marshal.ReadInt32(lpBuffer, 4)}, card={ReadStatusCardNo(lpBuffer, 8)}"
                        : "FAILED";
                    doneEvent.Set();
                    break;
                case HcNetSdkNative.NetSdkCallbackStatusException:
                    callbackError = "EXCEPTION";
                    doneEvent.Set();
                    break;
            }
        };

        var cond = SdkCardHelper.CreateCond(querySingle ? 1u : 0xffffffff);
        var remoteHandle = HcNetSdkNative.NET_DVR_StartRemoteConfig(
            userId,
            HcNetSdkNative.NetDvrGetCardCfgV50,
            ref cond,
            cond.dwSize,
            callback,
            IntPtr.Zero);

        if (remoteHandle < 0)
        {
            return (false, cards, $"StartRemoteConfig 失敗, error={HcNetSdkNative.NET_DVR_GetLastError()}");
        }

        if (querySingle && !SendCardNo(remoteHandle, cardNo))
        {
            HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
            return (false, cards, $"SendRemoteConfig 失敗, error={HcNetSdkNative.NET_DVR_GetLastError()}");
        }

        if (!doneEvent.Wait(TimeSpan.FromSeconds(60)))
        {
            HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
            return (false, cards, "查詢逾時（60 秒）");
        }

        HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
        return (string.IsNullOrEmpty(callbackError), cards, callbackError);
    }

    public static (bool Ok, string Error) WriteCard(int userId, SdkCardWriteRequest request)
    {
        var callbackError = string.Empty;
        var doneEvent = new ManualResetEventSlim(false);
        var success = false;

        HcNetSdkNative.RemoteConfigCallback callback = (dwType, lpBuffer, dwBufLen, _) =>
        {
            if (dwType != HcNetSdkNative.NetSdkCallbackTypeStatus || lpBuffer == IntPtr.Zero)
            {
                return;
            }

            var status = (uint)Marshal.ReadInt32(lpBuffer);
            switch (status)
            {
                case HcNetSdkNative.NetSdkCallbackStatusProcessing:
                    Console.WriteLine($"處理中: {ReadStatusCardNo(lpBuffer, 4)}");
                    break;
                case HcNetSdkNative.NetSdkCallbackStatusFailed:
                    callbackError = dwBufLen >= 8
                        ? $"error={Marshal.ReadInt32(lpBuffer, 4)}, card={ReadStatusCardNo(lpBuffer, 8)}"
                        : "FAILED";
                    doneEvent.Set();
                    break;
                case HcNetSdkNative.NetSdkCallbackStatusSuccess:
                    success = true;
                    doneEvent.Set();
                    break;
                case HcNetSdkNative.NetSdkCallbackStatusException:
                    callbackError = "EXCEPTION";
                    doneEvent.Set();
                    break;
            }
        };

        var cond = SdkCardHelper.CreateCond(1);
        var remoteHandle = HcNetSdkNative.NET_DVR_StartRemoteConfig(
            userId,
            HcNetSdkNative.NetDvrSetCardCfgV50,
            ref cond,
            cond.dwSize,
            callback,
            IntPtr.Zero);

        if (remoteHandle < 0)
        {
            return (false, $"StartRemoteConfig 失敗, error={HcNetSdkNative.NET_DVR_GetLastError()}");
        }

        var cardCfg = SdkCardHelper.BuildCardConfig(request);
        if (!HcNetSdkNative.NET_DVR_SendRemoteConfig(
                remoteHandle,
                HcNetSdkNative.EnumAcsSendData,
                SdkMarshal.StructToBytes(cardCfg),
                (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_CARD_CFG_V50>()))
        {
            HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
            return (false, $"SendRemoteConfig 失敗, error={HcNetSdkNative.NET_DVR_GetLastError()}");
        }

        if (!doneEvent.Wait(TimeSpan.FromSeconds(30)))
        {
            HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
            return (false, "等待設備回應逾時（30 秒）");
        }

        HcNetSdkNative.NET_DVR_StopRemoteConfig(remoteHandle);
        if (!success)
        {
            return (false, callbackError);
        }

        return (true, string.Empty);
    }

    private static bool SendCardNo(int remoteHandle, string cardNo)
    {
        var sendData = new HcNetSdkNative.NET_DVR_CARD_CFG_SEND_DATA
        {
            dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_CARD_CFG_SEND_DATA>(),
            byCardNo = new byte[HcNetSdkNative.AcsCardNoLen],
            byRes = new byte[12],
        };
        SdkCardHelper.SetCardNo(sendData.byCardNo, cardNo);
        return HcNetSdkNative.NET_DVR_SendRemoteConfig(
            remoteHandle,
            HcNetSdkNative.EnumAcsSendData,
            SdkMarshal.StructToBytes(sendData),
            sendData.dwSize);
    }

    private static string ReadStatusCardNo(IntPtr lpBuffer, int offset)
    {
        var bytes = new byte[HcNetSdkNative.AcsCardNoLen];
        Marshal.Copy(IntPtr.Add(lpBuffer, offset), bytes, 0, bytes.Length);
        return SdkCardHelper.ReadCardNo(bytes);
    }
}
