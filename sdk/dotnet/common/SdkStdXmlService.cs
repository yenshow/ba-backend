using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace HcNetSdkCommon;

internal static class SdkStdXmlService
{
    private const int DefaultOutBufferSize = 256 * 1024;
    private const int DefaultStatusBufferSize = 4096;

    public sealed record StdXmlResult(
        bool Ok,
        string Body,
        string StatusBody,
        uint ErrorCode,
        string? StatusString,
        string? SubStatusCode);

    public static StdXmlResult Request(
        int userId,
        string method,
        string uri,
        string? inBuffer = null,
        int timeoutMs = 15000)
    {
        var requestUrl = $"{method.Trim().ToUpperInvariant()} {uri.Trim()}";
        var urlBytes = Encoding.UTF8.GetBytes(requestUrl + "\0");
        var urlPtr = Marshal.AllocHGlobal(urlBytes.Length);
        Marshal.Copy(urlBytes, 0, urlPtr, urlBytes.Length);

        IntPtr inPtr = IntPtr.Zero;
        var inSize = 0;
        if (!string.IsNullOrEmpty(inBuffer))
        {
            var inBytes = Encoding.UTF8.GetBytes(inBuffer);
            inSize = inBytes.Length;
            inPtr = Marshal.AllocHGlobal(inSize);
            Marshal.Copy(inBytes, 0, inPtr, inSize);
        }

        var outPtr = Marshal.AllocHGlobal(DefaultOutBufferSize);
        var statusPtr = Marshal.AllocHGlobal(DefaultStatusBufferSize);
        ZeroMemory(outPtr, DefaultOutBufferSize);
        ZeroMemory(statusPtr, DefaultStatusBufferSize);

        try
        {
            var input = new HcNetSdkNative.NET_DVR_XML_CONFIG_INPUT
            {
                dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_XML_CONFIG_INPUT>(),
                lpRequestUrl = urlPtr,
                dwRequestUrlLen = (uint)(urlBytes.Length - 1),
                lpInBuffer = inPtr,
                dwInBufferSize = (uint)inSize,
                dwRecvTimeOut = (uint)Math.Max(1000, timeoutMs),
                byForceEncrpt = 0,
                byNumOfMultiPart = 0,
                byMIMEType = 0,
                byRes = new byte[29],
            };

            var output = new HcNetSdkNative.NET_DVR_XML_CONFIG_OUTPUT
            {
                dwSize = (uint)Marshal.SizeOf<HcNetSdkNative.NET_DVR_XML_CONFIG_OUTPUT>(),
                lpOutBuffer = outPtr,
                dwOutBufferSize = (uint)DefaultOutBufferSize,
                dwReturnedXMLSize = 0,
                lpStatusBuffer = statusPtr,
                dwStatusSize = (uint)DefaultStatusBufferSize,
                lpDataBuffer = IntPtr.Zero,
                byNumOfMultiPart = 0,
                byRes = new byte[23],
            };

            var ok = HcNetSdkNative.NET_DVR_STDXMLConfig(userId, ref input, ref output);
            var errorCode = ok ? 0u : HcNetSdkNative.NET_DVR_GetLastError();
            var returnedSize = (int)Math.Min(output.dwReturnedXMLSize, (uint)DefaultOutBufferSize);
            var body = DecodeText(outPtr, returnedSize, onlyIfPrintable: true);
            var statusBody = DecodeText(statusPtr, DefaultStatusBufferSize, onlyIfPrintable: true);
            var statusString = ExtractXmlTag(statusBody, "statusString");
            var subStatusCode = ExtractXmlTag(statusBody, "subStatusCode");

            if (!ok && !LooksLikeMarkupOrJson(body))
            {
                body = string.Empty;
            }

            return new StdXmlResult(ok, body, statusBody, errorCode, statusString, subStatusCode);
        }
        finally
        {
            Marshal.FreeHGlobal(urlPtr);
            if (inPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(inPtr);
            }

            Marshal.FreeHGlobal(outPtr);
            Marshal.FreeHGlobal(statusPtr);
        }
    }

    private static void ZeroMemory(IntPtr ptr, int size)
    {
        Marshal.Copy(new byte[size], 0, ptr, size);
    }

    private static string DecodeText(IntPtr ptr, int maxLen, bool onlyIfPrintable)
    {
        if (ptr == IntPtr.Zero || maxLen <= 0)
        {
            return string.Empty;
        }

        var buffer = new byte[maxLen];
        Marshal.Copy(ptr, buffer, 0, maxLen);
        var end = Array.IndexOf(buffer, (byte)0);
        var len = end >= 0 ? end : buffer.Length;
        if (len <= 0)
        {
            return string.Empty;
        }

        if (onlyIfPrintable && !LooksLikePrintable(buffer, len))
        {
            return string.Empty;
        }

        var utf8 = Encoding.UTF8.GetString(buffer, 0, len);
        if (!utf8.Contains('\uFFFD'))
        {
            return utf8.Trim();
        }

        try
        {
            return Encoding.GetEncoding(936).GetString(buffer, 0, len).Trim();
        }
        catch
        {
            return utf8.Trim();
        }
    }

    private static bool LooksLikePrintable(byte[] buffer, int len)
    {
        if (len <= 0)
        {
            return false;
        }

        var printable = 0;
        for (var i = 0; i < len; i++)
        {
            var b = buffer[i];
            if (b == 9 || b == 10 || b == 13 || (b >= 32 && b != 127) || b >= 0x80)
            {
                printable++;
            }
        }

        return printable * 100 / len >= 90;
    }

    private static bool LooksLikeMarkupOrJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var t = text.TrimStart();
        return t.StartsWith('<') || t.StartsWith('{') || t.StartsWith('[');
    }

    private static string? ExtractXmlTag(string xml, string tag)
    {
        if (string.IsNullOrEmpty(xml))
        {
            return null;
        }

        var match = Regex.Match(
            xml,
            $"<{tag}>(.*?)</{tag}>",
            RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return match.Success ? match.Groups[1].Value.Trim() : null;
    }
}
