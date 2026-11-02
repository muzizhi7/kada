import Foundation
import ImageIO
import CryptoKit

enum PetLook: String, Codable, CaseIterable {
    case kada, cat, rabbit, bear, custom
    var title: String {
        switch self {
        case .kada: return "Kada"
        case .cat: return "云朵猫"
        case .rabbit: return "奶糖兔"
        case .bear: return "团子熊"
        case .custom: return "自己的图片"
        }
    }
}

struct PetAppearance: Codable, Equatable {
    var name = "Kada"
    var look: PetLook = .kada
    var imageFile: String?
    static let original = PetAppearance()

    init(name: String = "Kada", look: PetLook = .kada, imageFile: String? = nil) {
        self.name = name; self.look = look; self.imageFile = imageFile
    }
    enum CodingKeys: CodingKey { case name, look, imageFile }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? "Kada"
        look = PetLook(rawValue: try values.decodeIfPresent(String.self, forKey: .look) ?? "kada") ?? .kada
        imageFile = try values.decodeIfPresent(String.self, forKey: .imageFile)
    }
    func validated() throws -> PetAppearance {
        var result = self
        result.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...20).contains(result.name.count), result.name.rangeOfCharacter(from: .newlines) == nil,
              !result.name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw PetError.message("名字需要1—20个字，不能换行。")
        }
        return result
    }
}

enum PetPicture {
    static let maximumBytes = 10 * 1024 * 1024
    static func png(from data: Data) throws -> Data {
        guard !data.isEmpty, data.count <= maximumBytes,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let kind = CGImageSourceGetType(source) as String?,
              ["public.png", "public.jpeg", "org.webmproject.webp", "public.heic", "public.heif"].contains(kind),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16384, height <= 16384,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 512,
                kCGImageSourceShouldCacheImmediately: true,
              ] as [CFString: Any] as CFDictionary) else {
            throw PetError.message("请选择10MB以内的PNG、JPG、WebP或HEIC图片。")
        }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, "public.png" as CFString, 1, nil) else {
            throw PetError.message("这张图片暂时无法使用，请换一张。")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw PetError.message("图片保存失败，请换一张。") }
        return encoded as Data
    }
    static func read(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size <= maximumBytes else {
            throw PetError.message("请选择10MB以内的图片文件。")
        }
        return try png(from: Data(contentsOf: url))
    }
}

/** Client-only preferences beside the app connection file. No task/model state. */
final class PetAppearanceStore {
    let directory: URL
    init(directory: URL) { self.directory = directory }
    private var file: URL { directory.appendingPathComponent("appearance.json") }
    private func ownedImage(_ name: String?) -> URL? {
        guard let name = name, name.range(of: "^look-[a-f0-9]{16}\\.png$", options: .regularExpression) != nil else { return nil }
        return directory.appendingPathComponent(name)
    }
    func imageData(for appearance: PetAppearance) -> Data? {
        guard let url = ownedImage(appearance.imageFile),
              (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { return nil }
        return try? PetPicture.read(url)
    }
    func load() -> PetAppearance {
        guard let data = try? Data(contentsOf: file), data.count <= 16384,
              let decoded = try? JSONDecoder().decode(PetAppearance.self, from: data),
              var value = try? decoded.validated() else { return .original }
        if value.imageFile != nil && imageData(for: value) == nil {
            value.imageFile = nil
            if value.look == .custom { value.look = .kada }
        }
        if value.look == .custom && value.imageFile == nil { value.look = .kada }
        return value
    }
    @discardableResult func save(_ appearance: PetAppearance, importedImage: Data? = nil) throws -> PetAppearance {
        var value = try appearance.validated()
        let previous = load()
        let picture = try importedImage.map { try PetPicture.png(from: $0) }
        if let picture = picture {
            let hash = SHA256.hash(data: picture).map { String(format: "%02x", $0) }.joined()
            value.imageFile = "look-" + String(hash.prefix(16)) + ".png"
        }
        if value.look == .custom && picture == nil && imageData(for: value) == nil {
            throw PetError.message("先选择一张喜欢的图片，再保存这个造型。")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let picture = picture, let target = ownedImage(value.imageFile) {
            try picture.write(to: target, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        if previous.imageFile != value.imageFile, let unused = ownedImage(previous.imageFile) { try? FileManager.default.removeItem(at: unused) }
        return value
    }
}
