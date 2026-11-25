"""device/ssh-forward.py — 临时 SSH 服务器，只为在真机上验证 dsh-host。

为什么需要它：dsh-go App 连「电脑/服务器」只有两条路 —— SSH 主机、DSH Remote（要账号）。
本机没装 OpenSSH Server（也不是管理员），所以这里用用户态 asyncssh 起一个最小 SSH 服务器：
  * 密码认证（任意用户名，密码见 PASSWORD）
  * direct-tcpip 端口转发，把隧道打到本地 127.0.0.1:TARGET_PORT（默认 3090 = dsh-host）
  * exec 也支持，但只回一行假的 launch URL（给 App 的 managed 模式兜底用）

配合 adb reverse：
  adb reverse tcp:2222 tcp:2222        # 手机 127.0.0.1:2222 → 电脑 2222
App 里：主机 127.0.0.1 / 端口 2222 / 用户 dev / 密码 codex
        模式「连接已有实例」 remotePort=3090 token=dev

    python device/ssh-forward.py [--port 2222] [--target 3090] [--password codex]
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import asyncssh


class Session(asyncssh.SSHServerSession):
    """冒充远端那个 `dsh web` 进程：只吐一行 launch URL，然后挂着不动。

    App 的「托管启动」模式会在远端执行 launchCommand（默认 `dsh web`），
    读 stdout 里的 `dsh web: http://…/?token=…` 拿到连接信息，再把远端端口
    经 SSH 隧道转过来。这里直接给它那一行，端口指向 dsh-host。
    """

    def __init__(self, url: str):
        self._url = url
        self._chan = None

    def connection_made(self, chan) -> None:
        self._chan = chan

    def shell_requested(self) -> bool:
        self._chan.write(f"dsh web: {self._url}\r\n")
        return True

    def exec_requested(self, command: str) -> bool:
        """回 App 的 bootstrap 脚本要的那几行 tag。

        `remote_bootstrap.dart` 的 startScript 输出格式：
            DSHAPP home <HOME>
            DSHAPP dsh <path>
            DSHAPP started <pid>
            DSHAPP url <http://127.0.0.1:PORT/?token=…>
        probe 脚本接受 `DSHAPP nodir`（没有实例）→ 于是 App 会走一次 start。
        """
        print(f"[ssh] exec: {command[:80]}…", flush=True)
        start_like = ("--port 0" in command) or ("started" in command) or ("nohup" in command)
        if start_like:
            self._chan.write(
                "DSHAPP home /tmp\n"
                "DSHAPP dsh /usr/local/bin/dsh\n"
                "DSHAPP started 4242\n"
                f"DSHAPP url {self._url}\n"
            )
        else:
            self._chan.write("DSHAPP nodir\n")
        # 让 channel 先把数据发出去，再收尾；同步 close 会让客户端丢帧
        asyncio.get_event_loop().call_later(0.05, self._chan.exit, 0)
        return True

    def data_received(self, data, datatype) -> None:
        pass

    def eof_received(self) -> bool:
        return False


class Server(asyncssh.SSHServer):
    def __init__(self, password: str, target_port: int, url: str):
        self._password = password
        self._target_port = target_port
        self._url = url
        self._peer = "?"

    # ---- 认证：任意用户名 + 固定密码
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        ok = password == self._password
        self._peer = username
        print(f"[ssh] password auth user={username} ok={ok}", flush=True)
        return ok

    def connection_made(self, connection) -> None:
        print(f"[ssh] connection from {connection.get_extra_info('peername')}", flush=True)

    # ---- direct-tcpip：App 的本地转发会走这里
    def connection_requested(self, dest_host: str, dest_port: int, orig_host: str, orig_port: int):
        # App 请求的是宿主机视角的 127.0.0.1:<remotePort>，而 dsh-host 就在本机同端口，
        # 所以直接放行：asyncssh 自己连 dest_host:dest_port。
        print(f"[ssh] forward {dest_host}:{dest_port} -> allow", flush=True)
        return True

    # ---- exec（App 的 managed 模式会执行 launchCommand）
    def session_requested(self):
        return Session(self._url)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2222)
    ap.add_argument("--target", type=int, default=3090)
    ap.add_argument("--password", default="codex")
    ap.add_argument("--url", default="", help="冒充的 launch URL，默认按 --target 生成")
    ap.add_argument("--debug", action="store_true", help="打印 asyncssh 协议日志")
    args = ap.parse_args()
    url = args.url or f"http://127.0.0.1:{args.target}/?token=dev"

    # host key 固定下来：每次重启都换指纹的话，App 会一直弹「主机指纹变了」
    key_path = Path(__file__).with_name("ssh_host_key")
    if key_path.exists():
        key = asyncssh.read_private_key(str(key_path))
    else:
        key = asyncssh.generate_private_key("ssh-ed25519")
        key.write_private_key(str(key_path))

    if args.debug:
        asyncssh.set_debug_level(2)

    await asyncssh.listen(
        host="0.0.0.0",
        port=args.port,
        server_factory=lambda: Server(args.password, args.target, url),
        server_host_keys=[key],
        allow_scp=False,
    )
    print(f"[ssh] listening 0.0.0.0:{args.port}  password={args.password}  launch={url}", flush=True)
    print(f"[ssh] direct-tcpip -> 127.0.0.1:{args.target}", flush=True)
    await asyncio.Future()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()) or 0)
    except KeyboardInterrupt:
        pass
