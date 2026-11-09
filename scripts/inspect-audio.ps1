Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AudioEndpoints {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEnum {
  int EnumAudioEndpoints(int flow,int state,out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
 }
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
  int Activate(ref Guid iid,int context,IntPtr parameters,out IntPtr value);
  int OpenPropertyStore(int access,out IStore store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);
  int GetState(out int state);
 }
 [StructLayout(LayoutKind.Sequential)] struct Key {public Guid id;public int pid;}
 [StructLayout(LayoutKind.Explicit,Size=24)] struct Value {[FieldOffset(0)]public ushort type;[FieldOffset(8)]public IntPtr text;}
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IStore {
  int GetCount(out int count);int GetAt(int index,out Key key);int GetValue(ref Key key,out Value value);
 }
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
 public static string Default(int role) {
  var e=(IEnum)new Enumerator(); IDevice d;Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0,role,out d));
  string id; d.GetId(out id); IStore s;d.OpenPropertyStore(0,out s);
  var key=new Key{id=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),pid=14};Value value; s.GetValue(ref key,out value);
  string name=Marshal.PtrToStringUni(value.text);PropVariantClear(ref value);
  Marshal.ReleaseComObject(s);Marshal.ReleaseComObject(d);Marshal.ReleaseComObject(e);
  return name+" | "+id;
 }
}
'@
0..2 | ForEach-Object { [PSCustomObject]@{Role=@('Console','Multimedia','Communications')[$_];Output=[AudioEndpoints]::Default($_)} } | ConvertTo-Json
