import dynamic from "next/dynamic";

// The entire OS is client state; rendering it on the server would only produce
// a frame that is thrown away on hydration.
const Desktop = dynamic(() => import("@/shell/Desktop").then((m) => m.Desktop));

export default function Page() {
  return <Desktop />;
}
