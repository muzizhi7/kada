import Foundation
import AppKit

@main struct PetCoreTests {
    static func main() throws {
        var checks = 0
        func expect(_ result: Bool, _ label: String) throws {
            guard result else { throw PetError.message("Failed: " + label) }
            checks += 1
        }
        let fixture = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        var object = try JSONSerialization.jsonObject(with: fixture) as! [String: Any]
        func decode(_ value: [String: Any]) throws -> PetTask { try JSONDecoder().decode(PetTask.self, from: JSONSerialization.data(withJSONObject: value)) }
        let ready = try decode(object)
        try expect(ready.mode == .confirm, "confirmation state")
        try expect(ready.confirmation?["revision"] as? Int == 2, "exact displayed revision")
        try expect(ready.confirmation?["digest"] as? String == String(repeating: "a", count: 64), "exact displayed digest")
        object["status"] = "running"
        try expect(try decode(object).confirmation == nil, "ordinary execution cannot authorize")
        for state in ["blocked", "failed", "needs_attention", "answered"] {
            object["status"] = state
            try expect(try decode(object).mode == .attention, "\(state) is not a successful delivery")
        }
        object["interaction"] = "chat"
        object["brief"] = NSNull(); object["briefDigest"] = NSNull()
        object["reply"] = ["timestamp": 1234, "text": "你好，可以直接聊。"]
        for state in ["running", "pending", "answered"] {
            object["status"] = state
            try expect(try decode(object).mode == .chat, "\(state) ordinary chat stays in the conversation panel")
        }
        let chat = try decode(object)
        try expect(chat.reply?.text == "你好，可以直接聊。" && chat.confirmation == nil, "normal answer is visible without a brief or confirmation")
        object["reply"] = ["timestamp": 2345, "text": "好的，有需要再叫我。"]
        try expect(try decode(object).attentionKey != chat.attentionKey, "a new chat reply can notify even with unchanged status")
        object.removeValue(forKey: "interaction"); object.removeValue(forKey: "reply")
        object["status"] = "completed"
        try expect(try decode(object).mode == .attention, "completed without actual delivery is not presented as success")
        object["delivery"] = ["summary": "保存了摘要", "artifacts": ["report.md"], "verification": "文件与内容自检", "assumptions": []]
        try expect(try decode(object).mode == .delivered, "completed candidate is delivered")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pi-pet-core-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let report = root.appendingPathComponent("中文 摘要.md")
        try "actual artifact".write(to: report, atomically: true, encoding: .utf8)
        let outside = directory.appendingPathComponent("outside.txt")
        try "outside".write(to: outside, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escaped.txt"), withDestinationURL: outside)
        let resolved = try PetFiles.artifact("中文 摘要.md", workspace: root.path)
        try expect(resolved.path == report.resolvingSymlinksInPath().path, "Unicode and spaces open the real artifact")
        let folder = root.appendingPathComponent("交付目录.md", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try expect(try PetFiles.artifact("交付目录.md", workspace: root.path).path == folder.path, "directory is a valid delivered artifact")
        try expect(!PetFiles.opensAsDocument(folder), "directory with document suffix is revealed rather than opened as a document")
        let empty = root.appendingPathComponent("empty.txt")
        try Data().write(to: empty)
        try expect(try PetFiles.artifact("empty.txt", workspace: root.path).path == empty.path, "empty file is a valid delivered artifact")
        try expect(try PetFiles.artifact(folder.path, workspace: root.path).path == folder.path, "absolute artifact path inside workspace is valid")
        try expect(try PetFiles.artifact(".", workspace: root.path).path == root.path, "workspace itself may be explicitly delivered")
        for path in ["../outside.txt", outside.path, "escaped.txt", "missing.txt", "file:///etc/passwd"] {
            var refused = false
            do { _ = try PetFiles.artifact(path, workspace: root.path) } catch { refused = true }
            try expect(refused, "reject invalid or escaped artifact \(path)")
        }
        try expect(PetFiles.opensAsDocument(report), "ordinary document opens with an app")
        for path in ["run.command", "script.sh", "untrusted.app", "link.webloc", "index.html", "vector.svg"] {
            try expect(!PetFiles.opensAsDocument(URL(fileURLWithPath: path)), "\(path) is revealed rather than executed")
        }
        let goal = PetFiles.objective("整理资料", attachments: [report])
        try expect(goal.contains(report.path) && goal.contains("保留原文件"), "attachments preserve explicit source paths")
        try expect(PetFiles.objective("整理资料", attachments: []) == "整理资料", "no attachment boilerplate")
        try expect(PetBudget(maxEstimatedCostUsd: 0.25, maxDurationMs: 60000).label.contains("$0.25"), "budget visible to the user")
        let revision = try PetBriefEdit.message("保留原件", cost: "0.30", minutes: "2")
        try expect(revision.contains("USD 0.3") && revision.contains("2 分钟") && revision.contains("确认前不要执行"), "budget edits request a new brief rather than preconfirming execution")
        for pair in [("0", "2"), ("nan", "2"), ("inf", "2"), ("0.3", "0"), ("0.3", "1.5")] {
            var refused = false
            do { _ = try PetBriefEdit.message("", cost: pair.0, minutes: pair.1) } catch { refused = true }
            try expect(refused, "invalid visible budget fields cannot be submitted")
        }
        let memoryJSON = """
        {"enabled":true,"updatedAt":1234,"facts":[{"id":"f1","text":"偏好中文","category":"preferences","scope":"project","certainty":"inferred","evidence":[{"path":"/tmp/USER.md","quote":"偏好中文","sha256":"hash","observedAt":1234}]}],"notices":[]}
        """
        let memory = try JSONDecoder().decode(PetMemoryView.self, from: Data(memoryJSON.utf8))
        try expect(memory.facts.first?.sourceLabel == "USER.md · 项目线索 · 待核实", "memory UI preserves project scope and uncertainty")
        try expect(memory.facts.first?.evidence.first?.quote == "偏好中文", "memory UI receives the actual quoted evidence")

        let profileDirectory = directory.appendingPathComponent("appearance", isDirectory: true)
        let store = PetAppearanceStore(directory: profileDirectory)
        try expect(store.load() == .original, "first launch has a usable default companion")
        try expect(store.load().name == "Kada" && store.load().look == .kada, "Kada is the default name and C6 appearance")
        let legacy = try JSONDecoder().decode(PetAppearance.self, from: Data("{\"name\":\"老朋友\",\"look\":\"cat\"}".utf8))
        try expect(legacy.name == "老朋友" && legacy.look == .cat, "legacy preferences remain selectable without rewriting user choices")
        let named = try store.save(PetAppearance(name: "  糯米 🐾  ", look: .rabbit))
        try expect(named.name == "糯米 🐾" && named.look == .rabbit, "name normalization and built-in look are saved together")
        try expect(PetAppearanceStore(directory: profileDirectory).load() == named, "name and look survive a new store instance")
        let saved = try Data(contentsOf: profileDirectory.appendingPathComponent("appearance.json"))
        for name in ["", "   ", "名字\n下一行", String(repeating: "团", count: 21), "x\0y"] {
            var refused = false
            do { try store.save(PetAppearance(name: name)) } catch { refused = true }
            try expect(refused, "invalid name does not overwrite preferences")
        }
        try expect(try Data(contentsOf: profileDirectory.appendingPathComponent("appearance.json")) == saved, "invalid edits leave saved bytes unchanged")
        try expect(try PetAppearance(name: "👨‍👩‍👧‍👦").validated().name == "👨‍👩‍👧‍👦", "emoji name retains its joined grapheme")
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: 500, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
        for y in 100..<350 { for x in 200..<750 {
            let pixel = bitmap.bitmapData! + y * bitmap.bytesPerRow + x * 4
            pixel[0] = 102; pixel[1] = 190; pixel[2] = 170; pixel[3] = 255
        } }
        let originalPNG = bitmap.representation(using: .png, properties: [:])!
        let sourceImage = directory.appendingPathComponent("my-look.png")
        try originalPNG.write(to: sourceImage)
        let normalizedPNG = try PetPicture.read(sourceImage)
        let reduced = NSBitmapImageRep(data: normalizedPNG)!
        try expect(reduced.pixelsWide == 512 && reduced.pixelsHigh == 256 && reduced.hasAlpha, "custom picture scales proportionally and preserves transparency")
        try expect(try Data(contentsOf: sourceImage) == originalPNG, "import never rewrites the original image")
        let custom = try store.save(PetAppearance(name: "米粒", look: .custom), importedImage: normalizedPNG)
        try FileManager.default.removeItem(at: sourceImage)
        try expect(PetAppearanceStore(directory: profileDirectory).load() == custom && store.imageData(for: custom) != nil, "owned copy survives original image deletion")
        let permissions = try FileManager.default.attributesOfItem(atPath: profileDirectory.appendingPathComponent("appearance.json").path)
        try expect((permissions[.posixPermissions] as? NSNumber)?.intValue == 0o600, "preferences have private file permissions")
        var bear = custom; bear.look = .bear
        try store.save(bear)
        try expect(store.imageData(for: store.load()) != nil, "switching to a built-in look keeps the last custom picture available")
        for data in [Data("not an image".utf8), Data(repeating: 0, count: PetPicture.maximumBytes + 1)] {
            var refused = false
            do { _ = try PetPicture.png(from: data) } catch { refused = true }
            try expect(refused, "invalid/oversized pictures are rejected before changing preferences")
        }
        let credential = profileDirectory.appendingPathComponent("connection.json")
        try Data("unrelated connection bytes".utf8).write(to: credential)
        try store.save(.original)
        try expect(store.load() == .original, "restoring defaults resets only companion preferences")
        try expect(!FileManager.default.fileExists(atPath: profileDirectory.appendingPathComponent(custom.imageFile!).path), "replacing the custom look removes only its owned unused asset")
        try expect(try String(contentsOf: credential) == "unrelated connection bytes", "reset cannot delete unrelated connection files")
        let metadata = profileDirectory.appendingPathComponent("appearance.json")
        try Data("{\"name\":\"我的伙伴\",\"look\":\"custom\",\"imageFile\":\"../connection.json\"}".utf8).write(to: metadata)
        try expect(store.load().look == .kada && store.load().name == "我的伙伴", "escaped image reference falls back locally while keeping the name")
        try Data("{\"name\":\"老朋友\",\"look\":\"future-look\"}".utf8).write(to: metadata)
        try expect(store.load().look == .kada && store.load().name == "老朋友", "unknown future look falls back without losing a valid name")
        try Data("broken json".utf8).write(to: metadata)
        try expect(store.load() == .original, "damaged preferences never prevent the pet from starting")
        let environment = try JSONDecoder().decode(PetEnvironment.self, from: Data("{\"enabled\":true,\"agents\":3,\"skills\":12,\"plugins\":2,\"overview\":\"/tmp/local-overview.md\"}".utf8))
        try expect(environment.enabled && environment.agents == 3 && environment.skills == 12 && environment.plugins == 2, "local inventory counts decode")
        try expect(environment.memory == nil, "older daemons remain decodable without user memory")
        let memoryEnvironment = try JSONDecoder().decode(PetEnvironment.self, from: Data("{\"enabled\":true,\"agents\":1,\"skills\":0,\"plugins\":0,\"overview\":null,\"memory\":\"/tmp/user-memory.md\"}".utf8))
        try expect(memoryEnvironment.memory == "/tmp/user-memory.md", "source-bound user memory can be opened independently of the capability inventory")
        try expect(environment.overview == "/tmp/local-overview.md", "environment overview path remains local")
        let disabledEnvironment = try JSONDecoder().decode(PetEnvironment.self, from: Data("{\"enabled\":false,\"agents\":0,\"skills\":0,\"plugins\":0,\"overview\":null}".utf8))
        try expect(!disabledEnvironment.enabled && disabledEnvironment.overview == nil, "disabled discovery needs no report path")
        print("Native core: \(checks) checks passed")
    }
}
