"""Run focused JS regression tests with Node, or macOS JavaScriptCore.
No browser automation, network calls or third-party Python dependencies.
"""
import ctypes as C
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / 'extension/content.js').read_text()
parts = []
for name, end in [('insertDraft', '\n/**'), ('setupCardInteractions', '\nfunction clampCardLayout'), ('handleCardKeydown', '\ndocument.addEventListener("keydown", handleCardKeydown'), ('clampCardLayout', '\n/**\n * Hang the card')]:
    start = src.index('function ' + name + '(')
    if src[max(0, start-6):start] == 'async ': start -= 6
    parts.append(src[start:src.index(end, start)])
tests = (ROOT / 'tests/extension_ui_runtime.js').read_text()
script = '\n'.join(parts) + '\n' + tests
if shutil.which('node'):
    subprocess.run(['node', '--check', str(ROOT/'extension/content.js')], check=True)
    subprocess.run(['node', '--check', str(ROOT/'extension/popup.js')], check=True)
    subprocess.run(['node', '-e', script], check=True)
    print('JS syntax and focused runtime assertions: PASS')
else:
    lib = C.CDLL('/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore')
    ptr = C.c_void_p
    lib.JSGlobalContextCreate.argtypes=[ptr];lib.JSGlobalContextCreate.restype=ptr
    lib.JSStringCreateWithUTF8CString.argtypes=[C.c_char_p];lib.JSStringCreateWithUTF8CString.restype=ptr
    lib.JSStringRelease.argtypes=[ptr]
    lib.JSCheckScriptSyntax.argtypes=[ptr,ptr,ptr,C.c_int,C.POINTER(ptr)];lib.JSCheckScriptSyntax.restype=C.c_bool
    lib.JSEvaluateScript.argtypes=[ptr,ptr,ptr,ptr,C.c_int,C.POINTER(ptr)];lib.JSEvaluateScript.restype=ptr
    lib.JSValueToStringCopy.argtypes=[ptr,ptr,C.POINTER(ptr)];lib.JSValueToStringCopy.restype=ptr
    lib.JSStringGetMaximumUTF8CStringSize.argtypes=[ptr];lib.JSStringGetMaximumUTF8CStringSize.restype=C.c_size_t
    lib.JSStringGetUTF8CString.argtypes=[ptr,C.c_char_p,C.c_size_t];lib.JSStringGetUTF8CString.restype=C.c_size_t
    ctx=lib.JSGlobalContextCreate(None)
    def string(value):
        s=lib.JSValueToStringCopy(ctx,value,None);n=lib.JSStringGetMaximumUTF8CStringSize(s);buf=C.create_string_buffer(n);lib.JSStringGetUTF8CString(s,buf,n);lib.JSStringRelease(s);return buf.value.decode()
    for filename in ['extension/content.js','extension/popup.js','website/main.js','website/builder.js']:
        code=lib.JSStringCreateWithUTF8CString((ROOT/filename).read_bytes());err=ptr()
        ok=lib.JSCheckScriptSyntax(ctx,code,None,1,C.byref(err));lib.JSStringRelease(code)
        if not ok:raise RuntimeError(filename+': '+string(err))
        print('Syntax PASS:',filename)
    code=lib.JSStringCreateWithUTF8CString(script.encode());err=ptr();result=lib.JSEvaluateScript(ctx,code,None,None,1,C.byref(err));lib.JSStringRelease(code)
    if err:raise RuntimeError(string(err))
    print(string(result))
