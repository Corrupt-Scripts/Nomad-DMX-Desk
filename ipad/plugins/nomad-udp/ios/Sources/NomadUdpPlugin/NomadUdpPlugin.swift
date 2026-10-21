import Foundation
import Capacitor
import Darwin

/// Plain UDP for Art-Net / sACN. One socket sends everything (and also hears unicast replies),
/// a second optional socket listens on a fixed port (6454) for broadcast replies from lighting nodes.
@objc(NomadUdpPlugin)
public class NomadUdpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NomadUdpPlugin"
    public let jsName = "NomadUdp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "localInfo", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "nomad.udp")
    private var sendFd: Int32 = -1
    private var sendSource: DispatchSourceRead?
    private var listenFd: Int32 = -1
    private var listenSource: DispatchSourceRead?

    // MARK: socket helpers

    private func makeSocket(port: UInt16, reuse: Bool) -> Int32 {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        if fd < 0 { return -1 }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, socklen_t(MemoryLayout<Int32>.size))
        if reuse {
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, socklen_t(MemoryLayout<Int32>.size))
        }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = 0 // INADDR_ANY
        let rc = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                Darwin.bind(fd, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if rc < 0 { close(fd); return -1 }
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        return fd
    }

    private func startReading(fd: Int32, local: Bool) -> DispatchSourceRead {
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            let cap = 2048
            var buf = [UInt8](repeating: 0, count: cap)
            while true {
                var from = sockaddr_in()
                var flen = socklen_t(MemoryLayout<sockaddr_in>.size)
                let n = withUnsafeMutablePointer(to: &from) { fp -> Int in
                    fp.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                        recvfrom(fd, &buf, cap, 0, sp, &flen)
                    }
                }
                if n <= 0 { break }
                let data = Data(buf[0..<n]).base64EncodedString()
                let host = String(cString: inet_ntoa(from.sin_addr))
                let port = Int(UInt16(bigEndian: from.sin_port))
                self.notifyListeners("udpMessage", data: ["data": data, "host": host, "port": port, "listener": !local])
            }
        }
        src.resume()
        return src
    }

    private func ensureSendSocket() -> Bool {
        if sendFd >= 0 { return true }
        let fd = makeSocket(port: 0, reuse: false)
        if fd < 0 { return false }
        sendFd = fd
        sendSource = startReading(fd: fd, local: true)
        return true
    }

    private func sendOne(host: String, port: Int, base64: String) -> String? {
        guard let data = Data(base64Encoded: base64) else { return "bad data" }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        if inet_pton(AF_INET, host, &addr.sin_addr) != 1 { return "bad address \(host)" }
        let rc = data.withUnsafeBytes { raw -> Int in
            withUnsafePointer(to: &addr) { ap in
                ap.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                    sendto(sendFd, raw.baseAddress, data.count, 0, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        if rc < 0 {
            let err = errno
            return String(cString: strerror(err))
        }
        return nil
    }

    // MARK: plugin methods

    @objc func send(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), let port = call.getInt("port"), let data = call.getString("data") else {
            call.reject("host, port and data are required"); return
        }
        queue.async {
            if !self.ensureSendSocket() { call.reject("Could not open a network socket"); return }
            if let err = self.sendOne(host: host, port: port, base64: data) { call.reject(err) } else { call.resolve() }
        }
    }

    @objc func sendBatch(_ call: CAPPluginCall) {
        guard let packets = call.getArray("packets") as? [[String: Any]] else {
            call.reject("packets are required"); return
        }
        queue.async {
            if !self.ensureSendSocket() { call.reject("Could not open a network socket"); return }
            var firstError: String? = nil
            var sent = 0
            for p in packets {
                guard let host = p["host"] as? String, let port = p["port"] as? Int, let data = p["data"] as? String else { continue }
                if let err = self.sendOne(host: host, port: port, base64: data) {
                    if firstError == nil { firstError = err }
                } else { sent += 1 }
            }
            if let e = firstError, sent == 0 { call.reject(e) } else { call.resolve(["sent": sent]) }
        }
    }

    @objc func listen(_ call: CAPPluginCall) {
        let port = call.getInt("port") ?? 6454
        queue.async {
            if self.listenFd >= 0 { call.resolve(["port": port]); return }
            let fd = self.makeSocket(port: UInt16(port), reuse: true)
            if fd < 0 { call.reject("Could not listen on port \(port)"); return }
            self.listenFd = fd
            self.listenSource = self.startReading(fd: fd, local: false)
            call.resolve(["port": port])
        }
    }

    @objc func stopListen(_ call: CAPPluginCall) {
        queue.async {
            self.listenSource?.cancel()
            self.listenSource = nil
            if self.listenFd >= 0 { close(self.listenFd); self.listenFd = -1 }
            call.resolve()
        }
    }

    @objc func localInfo(_ call: CAPPluginCall) {
        var out: [[String: Any]] = []
        var ifap: UnsafeMutablePointer<ifaddrs>? = nil
        if getifaddrs(&ifap) == 0, let first = ifap {
            var cur: UnsafeMutablePointer<ifaddrs>? = first
            while let p = cur {
                let ifa = p.pointee
                let flags = Int32(ifa.ifa_flags)
                if let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                   (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0, let nm = ifa.ifa_netmask {
                    let ip = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { String(cString: inet_ntoa($0.pointee.sin_addr)) }
                    let mask = nm.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { String(cString: inet_ntoa($0.pointee.sin_addr)) }
                    out.append(["name": String(cString: ifa.ifa_name), "ip": ip, "mask": mask])
                }
                cur = ifa.ifa_next
            }
            freeifaddrs(ifap)
        }
        call.resolve(["interfaces": out])
    }
}
