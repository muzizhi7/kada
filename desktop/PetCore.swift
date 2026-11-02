import Foundation

struct LaunchConfiguration: Decodable {
    let dataDir: String
    let port: Int
    let version: String
    var apiToken: String?
    var smokeDirectory: String?
    var appearanceSmokeVerifyOnly: Bool?
    var defaultsKey: String { "pet." + Data(dataDir.utf8).base64EncodedString() }
}

struct PetBudget: Codable, Equatable {
    let maxEstimatedCostUsd: Double
    let maxDurationMs: Double
    var maxTotalTokens: Int?
    var label: String {
        let minutes = max(1, Int(ceil(maxDurationMs / 60000)))
        return "最多 $\(Self.money(maxEstimatedCostUsd)) · \(minutes) 分钟"
    }
    static func money(_ amount: Double) -> String { String(format: amount < 0.01 ? "%.4f" : "%.2f", amount) }
}

struct PetVerification: Codable, Equatable { let command: String; let inputs: [String]; let outputs: [String] }
struct PetCriterion: Codable, Equatable { let text: String; let method: String; var verification: PetVerification? }
struct PetBrief: Decodable, Equatable {
    let revision: Int
    let outcome: String
    let deliverables: [String]
    let inputs: [String]
    let criteria: [PetCriterion]
    let scope: [String]
    let assumptions: [String]
    let questions: [String]
    let budget: PetBudget
}
struct PetUsage: Decodable, Equatable { let estimatedCostUsd: Double; let costLimit: Double? }
struct PetDelivery: Decodable, Equatable {
    let summary: String
    let artifacts: [String]
    let verification: String
    let assumptions: [String]
}
struct PetResumeBudget: Decodable, Equatable {
    let maxEstimatedCostUsd: Double?
    let maxDurationMs: Double
    let maxTotalTokens: Int?
}
struct PetTask: Decodable, Equatable {
    let id: String
    let objective: String
    let workspace: String
    let status: String
    let brief: PetBrief?
    let briefDigest: String?
    let confirmed: Bool
    let question: String?
    let reason: String?
    let budget: PetUsage
    let resumeBudget: PetResumeBudget
    let delivery: PetDelivery?

    enum Mode: String { case working, clarify, confirm, delivered, paused, budget, attention, cancelled }
    var mode: Mode {
        switch status {
        case "running", "pending", "verifying": return .working
        case "clarifying", "waiting_user": return .clarify
        case "awaiting_confirmation": return .confirm
        case "completed": return delivery == nil ? .attention : .delivered
        case "paused": return .paused
        case "budget_limited": return .budget
        case "cancelled": return .cancelled
        default: return .attention
        }
    }
    var attentionKey: String {
        "\(id):\(mode.rawValue):\(brief?.revision ?? 0):\(question ?? ""):\(reason ?? "")"
    }
    var confirmation: [String: Any]? {
        guard mode == .confirm, !confirmed, let brief = brief, brief.questions.isEmpty,
              let digest = briefDigest, digest.count == 64 else { return nil }
        return ["revision": brief.revision, "digest": digest]
    }
}
struct PetTaskItem: Decodable { let id: String; let objective: String; let status: String }
struct PetCreated: Decodable { let id: String }
struct PetOK: Decodable { let ok: Bool }
struct PetHealth: Decodable { let status: String; let version: String }
struct PetEnvironment: Decodable { let enabled: Bool; let agents: Int; let skills: Int; let plugins: Int; let overview: String? }
struct PetAPIError: Decodable { let error: String }

enum PetError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

final class PetAPI {
    let configuration: LaunchConfiguration
    private let session: URLSession
    init(_ configuration: LaunchConfiguration) {
        self.configuration = configuration
        let options = URLSessionConfiguration.ephemeral
        options.timeoutIntervalForRequest = 15
        options.timeoutIntervalForResource = 20
        options.urlCache = nil
        session = URLSession(configuration: options)
    }
    func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard (1...65535).contains(configuration.port), path.hasPrefix("/"), !path.contains(".."),
              let url = URL(string: "http://127.0.0.1:\(configuration.port)\(path)") else { throw PetError.message("本地连接地址无效。") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        let token: String
        if let supplied = configuration.apiToken { token = supplied }
        else { token = try String(contentsOf: URL(fileURLWithPath: configuration.dataDir).appendingPathComponent("token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
        guard token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw PetError.message("本地连接凭据无效，请重新启动桌面伙伴。") }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body = body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PetError.message("没有收到本地后台的回复。") }
        guard (200..<300).contains(response.statusCode) else {
            let detail = (try? JSONDecoder().decode(PetAPIError.self, from: data))?.error
            throw PetError.message(detail ?? "本地后台暂时不可用（\(response.statusCode)）。")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func checkHealth() async throws {
        let health: PetHealth = try await request("/health")
        guard health.status == "ok", health.version == configuration.version else {
            throw PetError.message("后台版本已更新，请关闭旧后台后重新启动桌面伙伴。")
        }
    }
    func task(_ id: String) async throws -> PetTask { try await request("/v1/tasks/\(id)/view") }
}

enum PetFiles {
    static func artifact(_ path: String, workspace: String) throws -> URL {
        guard !path.isEmpty, !path.contains("\0"), !path.contains("://") else { throw PetError.message("产物路径无效，请打开输出文件夹查看。") }
        let root = URL(fileURLWithPath: workspace, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        let target = ((path as NSString).isAbsolutePath ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)).standardizedFileURL.resolvingSymlinksInPath()
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { throw PetError.message("产物不在当前输出目录中。") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory) else {
            throw PetError.message("这个产物已移动或不存在，可以打开输出文件夹查看。")
        }
        let values = try target.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
        guard values.isRegularFile == true || values.isDirectory == true else { throw PetError.message("产物类型不支持，请在输出文件夹中查看。") }
        return target
    }
    static func opensAsDocument(_ url: URL) -> Bool {
        if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { return false }
        return ["pdf", "txt", "md", "markdown", "csv", "tsv", "json", "png", "jpg", "jpeg", "webp", "gif", "heic", "docx", "xlsx", "pptx"].contains(url.pathExtension.lowercased())
    }
    static func objective(_ text: String, attachments: [URL]) -> String {
        guard !attachments.isEmpty else { return text }
        return text + "\n\n用户提供的本地资料（可读取，保留原文件）：\n" + attachments.map { $0.path }.joined(separator: "\n")
    }
}
