import { describe, expect, it } from "vitest";
import { classifyJsonObjectPrefix } from "../src/adapters/session/jsonPrefix.js";

describe("B05 JSON 对象前缀识别", () => {
  it.each([
    "{}", ' {"s":"中😀\\n\\t\\b\\f\\r\\/\\\\\\"\\uD800","a":[true,false,null,-0,12.5e-2,{},[]]} \r\t',
    '{"x":0}', '{"x":-12}', '{"x":1.0}', '{"x":1E+12}', '{"x":[0,1]}',
  ])("完整对象：%s", (text) => {
    expect(classifyJsonObjectPrefix(Buffer.from(text))).toBe("complete");
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it.each([
    "", " \t\r", "{", '{"', '{"key', '{"key"', '{"key":', '{"key": ',
    '{"key":"', '{"key":"text', '{"key":"\\', '{"key":"\\u', '{"key":"\\u0',
    '{"key":"\\u0f', '{"key":"\\u0fA', '{"key":"\\u0fA0',
    '{"key":-', '{"key":0', '{"key":-0', '{"key":12', '{"key":12.', '{"key":12.3',
    '{"key":12e', '{"key":12e+', '{"key":12e-', '{"key":12e2',
    '{"key":t', '{"key":tr', '{"key":tru', '{"key":true',
    '{"key":f', '{"key":fa', '{"key":fal', '{"key":fals', '{"key":false',
    '{"key":n', '{"key":nu', '{"key":nul', '{"key":null',
    '{"key":[', '{"key":[1,', '{"key":[{"x":', '{"key":{},', '{"seq":6,',
  ])("可追加完成：%s", (text) => {
    expect(classifyJsonObjectPrefix(Buffer.from(text))).toBe("incomplete");
  });

  it.each([
    "[]", "null", "1", '"text"', "}", "{{", "{]", "{key", '{"a",', '{"a":}',
    '{"a":1,}', '{"a":[1,]}', '{"a":01}', '{"a":-01}', '{"a":+1}',
    '{"a":.1}', '{"a":1.}', '{"a":1e}', '{"a":1e+}', '{"a":--1}',
    '{"a":1 2}', '{"a":True}', '{"a":truX', '{"a":nullx}',
    '{"a":"\\x', '{"a":"\\u0g', '{"a":"raw\n', '{"a":"raw\t',
    '{"a":中', '{"a":"\\中', '{}{}', '{}x', '\ufeff{}', '{"seq":6,}',
  ])("不能靠追加修复：%s", (text) => {
    expect(classifyJsonObjectPrefix(Buffer.from(text))).toBe("invalid");
  });

  it.each(["中", "😀", "é"])("每个 UTF-8 字节拆分：%s", (character) => {
    const bytes = Buffer.from(`{"x":"${character}"}`);
    for (let end = 0; end < bytes.length; end++) {
      expect(classifyJsonObjectPrefix(bytes.subarray(0, end)), `byte=${end}`).toBe("incomplete");
    }
    expect(classifyJsonObjectPrefix(bytes)).toBe("complete");
  });

  it("UTF-8 残片只有在普通字符串内容处才可完成", () => {
    const half = Buffer.from([0xe4, 0xb8]);
    expect(classifyJsonObjectPrefix(Buffer.concat([Buffer.from('{"x":"'), half]))).toBe("incomplete");
    expect(classifyJsonObjectPrefix(Buffer.concat([Buffer.from('{"'), half]))).toBe("incomplete");
    for (const prefix of ["", '{"x":', '{"x":"\\', '{"x":"\\u', "{}", '{"x":1']) {
      expect(classifyJsonObjectPrefix(Buffer.concat([Buffer.from(prefix), half])), prefix).toBe("invalid");
    }
  });

  it.each([
    [0x80], [0xc0], [0xc1, 0xbf], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80],
    [0xf4, 0x90], [0xf5], [0xff], [0xe4, 0x20], [0xe4, 0xb8, 0x41],
  ])("严格拒绝非法 UTF-8：%j", (...values) => {
    expect(classifyJsonObjectPrefix(Buffer.concat([Buffer.from('{"x":"'), Buffer.from(values)]))).toBe("invalid");
  });

  it("所有合法 UTF-8 边界字节和尾部残片", () => {
    for (const sequence of [
      [0xc2, 0x80], [0xdf, 0xbf], [0xe0, 0xa0, 0x80], [0xed, 0x9f, 0xbf],
      [0xef, 0xbf, 0xbf], [0xf0, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf],
    ]) {
      for (let width = 1; width <= sequence.length; width++) {
        expect(classifyJsonObjectPrefix(Buffer.concat([Buffer.from('{"x":"'), Buffer.from(sequence.slice(0, width))]))).toBe("incomplete");
      }
    }
  });

  it("深度容器使用独立栈，不能用括号数量代替语法", () => {
    const text = '{"a":' + "[".repeat(2000) + "{}" + "]".repeat(2000) + "}";
    expect(classifyJsonObjectPrefix(Buffer.from(text))).toBe("complete");
    expect(classifyJsonObjectPrefix(Buffer.from('{"a":[{]},"b":[]}'))).toBe("invalid");
  });

  it("复杂合法对象的每个字节前缀均可完成，直到根闭合", () => {
    const text = '{"key":[{"汉字":"a\\n\\u1234😀"},true,false,null,-12.34e-5,{"b":[]}]}';
    const bytes = Buffer.from(text);
    for (let end = 0; end < bytes.length; end++) {
      expect(classifyJsonObjectPrefix(bytes.subarray(0, end)), `byte=${end}`).toBe("incomplete");
    }
    expect(classifyJsonObjectPrefix(bytes)).toBe("complete");
  });
});
