package com.ripple.app;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.Charset;
import java.security.KeyFactory;
import java.security.SecureRandom;
import java.security.spec.RSAPublicKeySpec;
import java.util.Random;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 网易云 weapi 加密 —— 与 Enji（ncm-api-rs）以及 NeteaseCloudMusicApi 的
 * util/crypto.js 完全一致，不是「老 /api/search/get 明文接口」那一套。
 *
 *   params    = Base64( AES-CBC( Base64( AES-CBC(明文 JSON, presetKey) ), randomKey ) )
 *   encSecKey = RSA_noPadding( reverse(randomKey) ) 的 hex
 *
 * 所有调用都以 POST + form(params, encSecKey) 发到
 *   https://music.163.com/weapi/<path>?csrf_token=<__csrf>
 * 这样才能带登录态、拿到 VIP 音质、每日推荐、喜欢列表等真实数据。
 */
final class Weapi {

    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final byte[] IV = "0102030405060708".getBytes(UTF8);
    private static final byte[] PRESET_KEY = "0CoJUm6Qyw8W8jud".getBytes(UTF8);
    private static final String B62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    /** 1024 位公钥：模数 + 指数 65537（与官方 weapi 常量一致） */
    private static final String MODULUS_HEX =
            "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629"
                    + "ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce1"
                    + "0b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
    private static final BigInteger MODULUS = new BigInteger(MODULUS_HEX, 16);
    private static final BigInteger EXPONENT = BigInteger.valueOf(65537);
    private static final int MOD_BYTES = 128;

    private static final Random RNG = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Weapi() {
    }

    /** 随机 16 位密钥（大小写字母 + 数字） */
    private static String randomKey() {
        StringBuilder b = new StringBuilder(16);
        for (int i = 0; i < 16; i++) b.append(B62.charAt(RNG.nextInt(B62.length())));
        return b.toString();
    }

    static String aesCbcBase64(String plain, byte[] key) throws Exception {
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(IV));
        return Base64.encode(c.doFinal(plain.getBytes(UTF8)));
    }

    /** RSA 教科书式加密（无 padding），输入左侧补 0 到 128 字节 */
    private static String rsaNoPadding(byte[] plain) throws Exception {
        byte[] block = new byte[MOD_BYTES];
        if (plain.length > MOD_BYTES) throw new IllegalArgumentException("key too long");
        System.arraycopy(plain, 0, block, MOD_BYTES - plain.length, plain.length);
        BigInteger m = new BigInteger(1, block);
        BigInteger c = m.modPow(EXPONENT, MODULUS);
        byte[] raw = c.toByteArray();
        // 去掉 BigInteger 可能带的前导 0，再左补到 128 字节
        int off = (raw.length > MOD_BYTES && raw[0] == 0) ? raw.length - MOD_BYTES : 0;
        int len = raw.length - off;
        byte[] out = new byte[MOD_BYTES];
        System.arraycopy(raw, off, out, MOD_BYTES - len, len);
        return hex(out);
    }

    static String hex(byte[] data) {
        char[] out = new char[data.length * 2];
        for (int i = 0; i < data.length; i++) {
            int v = data[i] & 0xff;
            out[i * 2] = HEX[v >>> 4];
            out[i * 2 + 1] = HEX[v & 0x0f];
        }
        return new String(out);
    }

    /** 明文 JSON → urlencoded 表单体（params / encSecKey） */
    static String form(String json) throws Exception {
        String secret = randomKey();
        String first = aesCbcBase64(json, PRESET_KEY);
        String params = aesCbcBase64(first, secret.getBytes(UTF8));
        StringBuilder rev = new StringBuilder(secret).reverse();
        String encSecKey = rsaNoPadding(rev.toString().getBytes(UTF8));
        return "params=" + urlEncode(params) + "&encSecKey=" + urlEncode(encSecKey);
    }

    static String urlEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    /** 从 __csrf cookie 取 CSRF token；未登录时为空串（读接口允许空） */
    static String csrf(String cookie) {
        if (cookie == null) return "";
        for (String part : cookie.split(";")) {
            String p = part.trim();
            if (p.startsWith("__csrf=")) return p.substring(7);
        }
        return "";
    }

    /** 极简 base64（Java 8 的 java.util.Base64 在 Android 上要 API 26，自备一份） */
    static final class Base64 {
        private static final char[] TBL =
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

        static String encode(byte[] data) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((data.length + 2) / 3 * 4);
            int i = 0;
            while (i + 2 < data.length) {
                int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
                out.write(TBL[(n >>> 18) & 63]);
                out.write(TBL[(n >>> 12) & 63]);
                out.write(TBL[(n >>> 6) & 63]);
                out.write(TBL[n & 63]);
                i += 3;
            }
            int rest = data.length - i;
            if (rest == 1) {
                int n = (data[i] & 0xff) << 16;
                out.write(TBL[(n >>> 18) & 63]);
                out.write(TBL[(n >>> 12) & 63]);
                out.write('=');
                out.write('=');
            } else if (rest == 2) {
                int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
                out.write(TBL[(n >>> 18) & 63]);
                out.write(TBL[(n >>> 12) & 63]);
                out.write(TBL[(n >>> 6) & 63]);
                out.write('=');
            }
            try {
                return out.toString("US-ASCII");
            } catch (Exception e) {
                return "";
            }
        }
    }
}
