import AppKit
import SwiftUI
import Combine
import UniformTypeIdentifiers

private enum Palette {
    static let ink = Color(red: 0.17, green: 0.20, blue: 0.32)
    static let muted = Color(red: 0.44, green: 0.49, blue: 0.60)
    static let blue = Color(red: 0.44, green: 0.25, blue: 0.75)
    static let wash = Color(red: 0.96, green: 0.94, blue: 0.99)
    static let line = Color(red: 0.86, green: 0.90, blue: 0.97)
}

@MainActor final class PetModel: ObservableObject {
    let api: PetAPI
    @Published var task: PetTask?
    @Published var draft = ""
    @Published var attachments: [URL] = []
    @Published var busy = false
    @Published var error: String?
    @Published var editing = false
    @Published var resumePrompt = false
    @Published private(set) var appearance: PetAppearance
    @Published private(set) var customPicture: NSImage?
    let appearanceStore: PetAppearanceStore
    var showBubble: ((Bool) -> Void)?
    var hideBubble: (() -> Void)?
    private var selectedID: String?
    private var lastAttention = ""
    private var generation = 0
    private var polling: Task<Void, Never>?
    private var failures = 0
    var mode: PetTask.Mode? { task?.mode ?? (selectedID == nil ? nil : .working) }
    var panelHeight: CGFloat {
        switch mode {
        case nil: return attachments.isEmpty ? 364 : 440
        case .confirm: return editing ? 618 : 554
        case .clarify: return 490
        case .delivered: return min(590, 326 + CGFloat(task?.delivery?.artifacts.count ?? 0) * 49)
        case .working: return 242
        case .paused, .budget, .attention: return 448
        case .cancelled: return 268
        }
    }
    init(_ configuration: LaunchConfiguration, appearanceDirectory: URL) {
        api = PetAPI(configuration)
        appearanceStore = PetAppearanceStore(directory: appearanceDirectory)
        let saved = appearanceStore.load()
        appearance = saved
        customPicture = appearanceStore.imageData(for: saved).flatMap { NSImage(data: $0) }
        selectedID = UserDefaults.standard.string(forKey: configuration.defaultsKey)
    }
    func saveAppearance(_ value: PetAppearance, importedImage: Data? = nil) throws {
        let saved = try appearanceStore.save(value, importedImage: importedImage)
        if appearance != saved { appearance = saved }
        customPicture = appearanceStore.imageData(for: saved).flatMap { NSImage(data: $0) }
    }
    func start() {
        polling = Task { [weak self] in
            guard let self = self else { return }
            do { try await self.api.checkHealth(); if self.error != nil { self.error = nil } }
            catch { self.error = "暂时联系不上本地后台。请稍后重试，已有任务会保留。"; self.showBubble?(false) }
            while !Task.isCancelled {
                if !self.busy { await self.refresh() }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
    func stop() { polling?.cancel() }
    func refresh() async {
        guard let id = selectedID else { return }
        let revision = generation
        do {
            let value = try await api.task(id)
            guard selectedID == id, generation == revision else { return }
            failures = 0
            if task != value { task = value }
            if error?.hasPrefix("暂时联系不上") == true { error = nil }
            if value.mode != .working && value.attentionKey != lastAttention {
                lastAttention = value.attentionKey
                showBubble?(false)
            }
        } catch {
            guard selectedID == id, generation == revision else { return }
            failures += 1
            if failures == 3 {
                self.error = "暂时联系不上本地后台。已有任务会保留，稍后点重试。"
                showBubble?(false)
            }
        }
    }
    func select(_ id: String) async {
        generation += 1
        selectedID = id
        task = nil; draft = ""; editing = false; error = nil; attachments = []; lastAttention = ""
        UserDefaults.standard.set(id, forKey: api.configuration.defaultsKey)
        await refresh()
        showBubble?(true)
    }
    func newGoal() {
        generation += 1; selectedID = nil; lastAttention = ""
        UserDefaults.standard.removeObject(forKey: api.configuration.defaultsKey)
        task = nil; draft = ""; attachments = []; editing = false; error = nil
        showBubble?(true)
    }
    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        let objective = PetFiles.objective(text, attachments: attachments)
        guard objective.count <= 32000 else { error = "目标太长了，请缩短说明，或将详细资料作为附件添加。"; return }
        perform {
            if let id = self.selectedID {
                let _: PetOK = try await self.api.request("/v1/tasks/\(id)/messages", method: "POST", body: ["message": text, "requestId": UUID().uuidString])
            } else {
                let created: PetCreated = try await self.api.request("/v1/tasks", method: "POST", body: ["objective": objective, "confirmed": false])
                self.selectedID = created.id
                UserDefaults.standard.set(created.id, forKey: self.api.configuration.defaultsKey)
            }
            self.draft = ""; self.attachments = []; self.editing = false
            await self.refresh()
            if self.mode == .working { self.hideBubble?() }
        }
    }
    func confirm() {
        guard let current = task, let approval = current.confirmation else { return }
        perform {
            let _: PetOK = try await self.api.request("/v1/tasks/\(current.id)/confirm", method: "POST", body: approval)
            await self.refresh()
            if self.mode == .working { self.hideBubble?() }
        }
    }
    func control(_ action: String) {
        guard let current = task, ["pause", "resume", "cancel"].contains(action) else { return }
        perform {
            let _: PetOK = try await self.api.request("/v1/tasks/\(current.id)/\(action)", method: "POST", body: [:])
            await self.refresh()
            if action == "resume", self.mode == .working { self.hideBubble?() }
        }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil; generation += 1
        Task {
            defer { busy = false }
            do { try await operation() }
            catch {
                self.error = error.localizedDescription
                await refresh()
                showBubble?(true)
            }
        }
    }
    func addFiles() {
        let panel = NSOpenPanel()
        panel.title = "选择要使用的资料"; panel.prompt = "添加资料"
        panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        if panel.runModal() == .OK {
            for url in panel.urls where !attachments.contains(url) { attachments.append(url) }
        }
    }
    func openArtifact(_ path: String) {
        guard let task = task else { return }
        do {
            let url = try PetFiles.artifact(path, workspace: task.workspace)
            if PetFiles.opensAsDocument(url) { if !NSWorkspace.shared.open(url) { throw PetError.message("没有找到能打开此文件的应用，可以在文件夹中查看。") } }
            else { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        } catch { self.error = error.localizedDescription }
    }
    func openFolder() {
        guard let workspace = task?.workspace else { return }
        let url = URL(fileURLWithPath: workspace, isDirectory: true)
        if !NSWorkspace.shared.open(url) { error = "输出目录已移动或不存在。" }
    }
    var resumeMessage: String {
        guard let task = task else { return "" }
        let cap = task.resumeBudget.maxEstimatedCostUsd.map { "$" + PetBudget.money($0) } ?? "\(task.resumeBudget.maxTotalTokens ?? 500000) token"
        return "已用约 $\(PetBudget.money(task.budget.estimatedCostUsd))。这次会追加 \(cap)，时限 \(max(1, Int(task.resumeBudget.maxDurationMs / 60000))) 分钟。已完成的工作会保留。"
    }
}

private struct PetButton: ButtonStyle {
    var primary = true
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .foregroundColor(primary ? .white : Palette.ink)
            .background(primary ? Palette.blue.opacity(configuration.isPressed ? 0.82 : 1) : Palette.wash, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
            .opacity(enabled ? 1 : 0.45)
    }
}

private struct BubbleTail: Shape {
    func path(in r: CGRect) -> Path {
        Path { p in p.move(to: .zero); p.addLine(to: CGPoint(x: r.width, y: 0)); p.addQuadCurve(to: CGPoint(x: r.width * 0.7, y: r.height), control: CGPoint(x: r.width * 0.95, y: r.height * 0.4)); p.closeSubpath() }
    }
}

private struct PetBubble: View {
    @ObservedObject var model: PetModel
    var close: () -> Void
    var menu: () -> Void
    @State private var focused = false
    @State private var focusRequest = 0

    var body: some View {
        shell.preferredColorScheme(.light)
            .onAppear { focusInput() }
            .onChange(of: model.task?.status) { _ in focusInput() }
            .alert("补充预算后继续？", isPresented: $model.resumePrompt) {
                Button("先不继续", role: .cancel) {}
                Button("补充并继续") { model.control("resume") }
            } message: { Text(model.resumeMessage) }
    }
    private func focusInput() {
        if model.mode == nil || model.mode == .clarify || model.mode == .attention || model.editing { focusRequest += 1 }
    }
    private var shell: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 7) {
                    Image(systemName: "square.stack.3d.up.fill").foregroundColor(Palette.blue).font(.system(size: 12))
                    Text(model.appearance.name).font(.system(size: 12, weight: .medium)).foregroundColor(Palette.muted).lineLimit(1)
                    Spacer()
                    Button(action: menu) { Image(systemName: "ellipsis").frame(width: 26, height: 24) }.buttonStyle(.plain).help("最近任务与设置").accessibilityLabel("更多")
                    Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).frame(width: 22, height: 24) }.buttonStyle(.plain).help("收起气泡，后台继续执行").accessibilityLabel("收起气泡")
                }.foregroundColor(Palette.muted)
                if let error = model.error {
                    Text(error).font(.system(size: 12)).foregroundColor(Color(red: 0.64, green: 0.28, blue: 0.25)).fixedSize(horizontal: false, vertical: true)
                }
                content
            }
            .padding(22).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 23))
            .overlay(RoundedRectangle(cornerRadius: 23).strokeBorder(Palette.line.opacity(0.65), lineWidth: 1))
            BubbleTail().fill(.white).frame(width: 24, height: 12).offset(x: 112, y: -1)
        }
        .padding(12).foregroundColor(Palette.ink)
        .font(.system(size: 13, design: .rounded))
        .compositingGroup()
        .shadow(color: Color(red: 0.26, green: 0.32, blue: 0.49).opacity(0.16), radius: 10, y: 4)
        .frame(width: 380, height: model.panelHeight)
    }

    @ViewBuilder private var content: some View {
        switch model.mode {
        case nil:
            heading("今天，想做成什么？", "把目标交给我，做好了叫你。")
            editor("比如：把这些资料整理成一份报告")
            if !model.attachments.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.attachments, id: \.path) { url in
                            HStack(spacing: 6) {
                                Image(systemName: "paperclip").foregroundColor(Palette.blue)
                                Text(url.lastPathComponent).lineLimit(1).help(url.path)
                                Spacer()
                                Button { model.attachments.removeAll { $0 == url } } label: { Image(systemName: "xmark.circle.fill").foregroundColor(Palette.muted) }.buttonStyle(.plain).accessibilityLabel("移除 \(url.lastPathComponent)")
                            }.font(.system(size: 12))
                        }
                    }
                }.frame(maxHeight: 64)
            }
            HStack {
                Button { model.addFiles() } label: { Label("添加资料", systemImage: "paperclip") }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                Text("开始前确认标准与预算").font(.system(size: 11)).foregroundColor(Palette.muted)
            }
            sendButton("交给你")
        case .clarify:
            heading("还差一点信息。", "一起说清楚，我就能继续。")
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    let questions = model.task?.brief?.questions ?? []
                    if questions.isEmpty { Text(model.task?.question ?? "请补充影响结果的必要信息。") }
                    else { ForEach(Array(questions.enumerated()), id: \.offset) { _, text in Text(text).fixedSize(horizontal: false, vertical: true) } }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            editor("补充你的要求…")
            sendButton("补充说明")
        case .confirm:
            heading("这样交付，可以吗？", nil)
            if let brief = model.task?.brief {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(brief.outcome).font(.system(size: 14, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                        lines("交付给你", brief.deliverables)
                        VStack(alignment: .leading, spacing: 7) {
                            sectionLabel("做到这些")
                            ForEach(Array(brief.criteria.enumerated()), id: \.offset) { _, criterion in
                                Text("• \(criterion.text)〔\(criterion.method == "check" ? "命令核验" : "内容自检")〕").fixedSize(horizontal: false, vertical: true)
                                if let verification = criterion.verification {
                                    Text("核对方式：\(verification.command)\n保持原样：\(verification.inputs.joined(separator: "、"))\n核对产物：\(verification.outputs.joined(separator: "、"))")
                                        .font(.system(size: 11)).foregroundColor(Palette.muted).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        lines("资料与范围", brief.inputs + brief.scope)
                        if !brief.assumptions.isEmpty { lines("约定与限制", brief.assumptions) }
                    }.padding(.trailing, 5).frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(brief.budget.label).font(.system(size: 13, weight: .semibold))
                    Text("含准备阶段已用约 $\(PetBudget.money(model.task?.budget.estimatedCostUsd ?? 0))").font(.system(size: 11)).foregroundColor(Palette.muted)
                    if let tokens = brief.budget.maxTotalTokens { Text("累计 token 上限 \(tokens)").font(.system(size: 11)).foregroundColor(Palette.muted) }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.wash, in: RoundedRectangle(cornerRadius: 12))
            }
            if model.editing {
                editor("想调整目标、标准或预算？")
                sendButton("更新说明")
            } else {
                HStack(spacing: 9) {
                    Button("调整一下") { model.editing = true; focusInput() }.buttonStyle(PetButton(primary: false))
                    Button("确认，开始吧") { model.confirm() }.buttonStyle(PetButton()).disabled(model.busy || model.task?.confirmation == nil)
                }
            }
        case .working:
            heading(model.task?.confirmed == false ? "我先理清目标。" : "交给我，你先忙。", model.task?.confirmed == false ? "需要确认时再叫你。" : "完成后，我会把文件递给你。")
            Spacer(minLength: 0)
            HStack(spacing: 9) {
                Button("暂停任务") { model.control("pause") }.buttonStyle(PetButton(primary: false)).disabled(model.busy)
                Button("收起，等结果") { close() }.buttonStyle(PetButton())
            }
        case .delivered:
            heading("做好啦，给你。", "文件都留在你的电脑上。")
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.task?.delivery?.artifacts ?? [], id: \.self) { path in
                        Button { model.openArtifact(path) } label: {
                            HStack(spacing: 11) {
                                Image(systemName: "doc.text").font(.system(size: 20)).foregroundColor(Palette.blue).frame(width: 28)
                                Text((path as NSString).lastPathComponent).font(.system(size: 13, weight: .medium)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "arrow.up.right").font(.system(size: 11)).foregroundColor(Palette.muted)
                            }.padding(12).background(Palette.wash, in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain).help(path).accessibilityLabel("打开产物 \(path)")
                    }
                    DisclosureGroup("交付说明") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(model.task?.delivery?.summary ?? "")
                            Text(model.task?.delivery?.verification ?? "").foregroundColor(Palette.muted)
                            ForEach(model.task?.delivery?.assumptions ?? [], id: \.self) { Text($0).foregroundColor(Palette.muted) }
                        }.font(.system(size: 12)).padding(.top, 7).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.font(.system(size: 12)).tint(Palette.muted).padding(.top, 5)
                }
            }
            Text("这次估算费用 $\(PetBudget.money(model.task?.budget.estimatedCostUsd ?? 0))").font(.system(size: 11)).foregroundColor(Palette.muted)
            HStack(spacing: 9) {
                Button("打开文件夹") { model.openFolder() }.buttonStyle(PetButton(primary: false))
                Button("新的目标") { model.newGoal() }.buttonStyle(PetButton())
            }
        case .paused, .budget, .attention:
            heading(model.mode == .budget ? "需要定一下预算。" : model.mode == .paused ? "这件事暂停着。" : "这里需要你帮一下。", nil)
            ScrollView { Text(model.task?.question ?? model.task?.reason ?? "请补充说明，或保留当前工作稍后继续。").frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
            if model.mode == .attention {
                editor("补充材料或调整要求…")
                sendButton("发给你")
            } else {
                Text(model.resumeMessage).font(.system(size: 12)).foregroundColor(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Button("补充预算并继续…") { model.resumePrompt = true }.buttonStyle(PetButton()).disabled(model.busy)
            }
            Button("保留工作，开始新目标") { model.newGoal() }.buttonStyle(.plain).foregroundColor(Palette.muted).font(.system(size: 12)).frame(maxWidth: .infinity)
        case .cancelled:
            heading("这件事先放一放。", "已有文件保留在原来的位置。")
            Spacer(minLength: 0)
            HStack(spacing: 9) {
                Button("查看文件") { model.openFolder() }.buttonStyle(PetButton(primary: false))
                Button("新的目标") { model.newGoal() }.buttonStyle(PetButton())
            }
        }
    }
    private func heading(_ title: String, _ subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 21, weight: .semibold, design: .rounded)).tracking(-0.4)
            if let subtitle = subtitle { Text(subtitle).font(.system(size: 13)).foregroundColor(Palette.muted) }
        }
    }
    private func sectionLabel(_ text: String) -> some View { Text(text).font(.system(size: 12, weight: .semibold)).foregroundColor(Palette.muted) }
    private func lines(_ title: String, _ values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionLabel(title)
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in Text("• " + value).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
        }
    }
    private func editor(_ placeholder: String) -> some View {
        ZStack(alignment: .topLeading) {
            if model.draft.isEmpty { Text(placeholder).foregroundColor(Palette.muted).padding(.horizontal, 11).padding(.vertical, 12).allowsHitTesting(false) }
            PetDraftInput(text: $model.draft, focused: $focused, label: placeholder, focusRequest: focusRequest, submit: { model.submit() }).padding(6)
        }.frame(height: model.editing ? 74 : 88)
            .background(Palette.wash.opacity(0.65), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focused ? Palette.blue.opacity(0.7) : Palette.line, lineWidth: 1))
    }
    private func sendButton(_ label: String) -> some View {
        Button(model.busy ? "正在交给\(model.appearance.name)…" : label) { model.submit() }.buttonStyle(PetButton())
            .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
    }
}

/** Original vector artwork. Only blink frames are timed; no assets or render engine. */
private final class CompanionView: NSView {
    var press: (() -> Void)?
    var showMenu: (() -> Void)?
    var moved: (() -> Void)?
    var resting = false { didSet { needsDisplay = true } }
    var delivered = false { didSet { needsDisplay = true } }
    var petAppearance = PetAppearance.original {
        didSet {
            needsDisplay = true
            toolTip = "\(petAppearance.name) · 点击交谈，右键换名字与造型"
            setAccessibilityLabel("\(petAppearance.name)，点击交谈，拖动换位置，右键打开菜单")
        }
    }
    var customPicture: NSImage? { didSet { needsDisplay = true } }
    var showsName = true
    var animates = true { didSet { if !animates { timer?.invalidate(); timer = nil } } }
    private var blink = false
    private var timer: Timer?
    private var startMouse = NSPoint.zero
    private var startFrame = NSPoint.zero
    private var dragged = false
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel("\(petAppearance.name)，点击交谈，拖动换位置，右键打开菜单")
        toolTip = "\(petAppearance.name) · 点击交谈，右键换名字与造型"
        timer = Timer.scheduledTimer(withTimeInterval: 5.2, repeats: true) { [weak self] _ in
            guard let self = self, !self.resting, self.petAppearance.look != .custom else { return }
            self.blink = true; self.needsDisplay = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) { [weak self] in self?.blink = false; self?.needsDisplay = true }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { timer?.invalidate() }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { press?(); return true }
    override func mouseDown(with event: NSEvent) { startMouse = NSEvent.mouseLocation; startFrame = window?.frame.origin ?? .zero; dragged = false }
    override func mouseDragged(with event: NSEvent) {
        let now = NSEvent.mouseLocation
        if hypot(now.x - startMouse.x, now.y - startMouse.y) > 4 { dragged = true }
        if dragged { window?.setFrameOrigin(NSPoint(x: startFrame.x + now.x - startMouse.x, y: startFrame.y + now.y - startMouse.y)); moved?() }
    }
    override func mouseUp(with event: NSEvent) { if !dragged { press?() }; moved?() }
    override func rightMouseDown(with event: NSEvent) { showMenu?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState(); context.scaleBy(x: bounds.width / 160, y: bounds.height / 146)
        let appearance = petAppearance
        let ink = NSColor(calibratedRed: 0.26, green: 0.32, blue: 0.48, alpha: 1)
        let fur: NSColor = appearance.look == .rabbit ? NSColor(calibratedRed: 0.98, green: 0.91, blue: 0.86, alpha: 1) : appearance.look == .bear ? NSColor(calibratedRed: 0.81, green: 0.71, blue: 0.61, alpha: 1) : NSColor(calibratedRed: 0.84, green: 0.90, blue: 1.0, alpha: 1)
        let light: NSColor = appearance.look == .cat ? NSColor(calibratedRed: 0.96, green: 0.98, blue: 1, alpha: 1) : NSColor(calibratedRed: 1, green: 0.97, blue: 0.92, alpha: 1)
        let pink = NSColor(calibratedRed: 0.97, green: 0.73, blue: 0.75, alpha: 1)
        func oval(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: NSColor) { color.setFill(); NSBezierPath(ovalIn: NSRect(x: x, y: y, width: w, height: h)).fill() }
        func path(_ color: NSColor, _ outline: Bool = false, _ body: (NSBezierPath) -> Void) {
            let p = NSBezierPath(); body(p); color.setFill(); p.fill()
            if outline { ink.withAlphaComponent(0.60).setStroke(); p.lineWidth = 1.6; p.lineJoinStyle = .round; p.stroke() }
        }
        func stroke(_ color: NSColor = ink, width: CGFloat = 2, _ body: (NSBezierPath) -> Void) { let p = NSBezierPath(); body(p); color.setStroke(); p.lineWidth = width; p.lineCapStyle = .round; p.stroke() }
        func nameTag() {
            guard showsName else { return }
            let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center; paragraph.lineBreakMode = .byTruncatingTail
            let text = NSAttributedString(string: appearance.name, attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .medium), .foregroundColor: ink, .paragraphStyle: paragraph])
            let width = min(136, max(44, text.size().width + 16))
            path(NSColor.white.withAlphaComponent(0.93)) { $0.appendRoundedRect(NSRect(x: 80 - width / 2, y: 132, width: width, height: 14), xRadius: 7, yRadius: 7) }
            text.draw(in: NSRect(x: 86 - width / 2, y: 132.5, width: width - 12, height: 13))
        }
        if appearance.look == .custom, let picture = customPicture {
            oval(26, 130, 108, 8, ink.withAlphaComponent(0.1))
            let scale = min(128 / max(picture.size.width, 1), 126 / max(picture.size.height, 1))
            let size = NSSize(width: picture.size.width * scale, height: picture.size.height * scale)
            picture.draw(in: NSRect(x: (160 - size.width) / 2, y: (128 - size.height) / 2, width: size.width, height: size.height), from: .zero, operation: .sourceOver, fraction: resting ? 0.9 : 1, respectFlipped: true, hints: nil)
            oval(124, 14, 14, 14, .white)
            oval(127, 17, 8, 8, delivered ? NSColor.systemGreen : resting ? NSColor.systemPurple : NSColor.systemBlue)
            nameTag(); context.restoreGState(); return
        }
        if appearance.look == .kada {
            drawKada()
            nameTag(); context.restoreGState(); return
        }
        oval(26, 130, 116, 9, ink.withAlphaComponent(0.12))
        // Curling tail, pear-shaped body, and two little feet.
        if appearance.look == .cat {
            stroke(ink.withAlphaComponent(0.6), width: 17) { p in p.move(to: NSPoint(x: 111, y: 120)); p.curve(to: NSPoint(x: 137, y: 91), controlPoint1: NSPoint(x: 148, y: 129), controlPoint2: NSPoint(x: 153, y: 93)) }
            stroke(fur, width: 14) { p in p.move(to: NSPoint(x: 111, y: 120)); p.curve(to: NSPoint(x: 137, y: 91), controlPoint1: NSPoint(x: 148, y: 129), controlPoint2: NSPoint(x: 153, y: 93)) }
        } else { path(light, true) { $0.appendOval(in: NSRect(x: 117, y: 107, width: 22, height: 22)) } }
        path(fur, true) { p in p.move(to: NSPoint(x: 51, y: 79)); p.curve(to: NSPoint(x: 37, y: 121), controlPoint1: NSPoint(x: 39, y: 89), controlPoint2: NSPoint(x: 33, y: 108)); p.curve(to: NSPoint(x: 121, y: 121), controlPoint1: NSPoint(x: 40, y: 139), controlPoint2: NSPoint(x: 111, y: 139)); p.curve(to: NSPoint(x: 109, y: 80), controlPoint1: NSPoint(x: 128, y: 109), controlPoint2: NSPoint(x: 119, y: 89)); p.close() }
        oval(58, 91, 44, 39, light)
        path(light, true) { p in p.appendRoundedRect(NSRect(x: 41, y: 119, width: 29, height: 14), xRadius: 7, yRadius: 7) }
        path(light, true) { p in p.appendRoundedRect(NSRect(x: 91, y: 119, width: 29, height: 14), xRadius: 7, yRadius: 7) }
        // Rounded ear tips are part of the head silhouette.
        if appearance.look == .rabbit {
            for x: CGFloat in [44, 96] {
                path(fur, true) { $0.appendRoundedRect(NSRect(x: x, y: 1, width: 20, height: 56), xRadius: 10, yRadius: 10) }
                path(pink) { $0.appendRoundedRect(NSRect(x: x + 6, y: 9, width: 8, height: 36), xRadius: 4, yRadius: 4) }
            }
            path(fur, true) { $0.appendRoundedRect(NSRect(x: 28, y: 33, width: 104, height: 65), xRadius: 32, yRadius: 32) }
        } else if appearance.look == .bear {
            for x: CGFloat in [27, 106] {
                path(fur, true) { $0.appendOval(in: NSRect(x: x, y: 19, width: 28, height: 30)) }
                oval(x + 7, 25, 14, 16, pink.withAlphaComponent(0.7))
            }
            path(fur, true) { $0.appendRoundedRect(NSRect(x: 28, y: 31, width: 104, height: 67), xRadius: 30, yRadius: 30) }
        } else {
        path(fur, true) { p in
            p.move(to: NSPoint(x: 36, y: 43)); p.curve(to: NSPoint(x: 36, y: 14), controlPoint1: NSPoint(x: 30, y: 26), controlPoint2: NSPoint(x: 30, y: 8))
            p.curve(to: NSPoint(x: 60, y: 28), controlPoint1: NSPoint(x: 42, y: 14), controlPoint2: NSPoint(x: 53, y: 20))
            p.curve(to: NSPoint(x: 99, y: 28), controlPoint1: NSPoint(x: 74, y: 24), controlPoint2: NSPoint(x: 87, y: 24))
            p.curve(to: NSPoint(x: 125, y: 15), controlPoint1: NSPoint(x: 109, y: 19), controlPoint2: NSPoint(x: 122, y: 10))
            p.curve(to: NSPoint(x: 126, y: 46), controlPoint1: NSPoint(x: 131, y: 15), controlPoint2: NSPoint(x: 132, y: 33))
            p.curve(to: NSPoint(x: 119, y: 91), controlPoint1: NSPoint(x: 140, y: 64), controlPoint2: NSPoint(x: 135, y: 84))
            p.curve(to: NSPoint(x: 39, y: 90), controlPoint1: NSPoint(x: 101, y: 104), controlPoint2: NSPoint(x: 59, y: 104))
            p.curve(to: NSPoint(x: 36, y: 43), controlPoint1: NSPoint(x: 22, y: 77), controlPoint2: NSPoint(x: 24, y: 55)); p.close()
        }
        path(pink) { p in p.move(to: NSPoint(x: 38, y: 22)); p.line(to: NSPoint(x: 52, y: 33)); p.line(to: NSPoint(x: 38, y: 39)); p.close() }
        path(pink) { p in p.move(to: NSPoint(x: 121, y: 23)); p.line(to: NSPoint(x: 108, y: 34)); p.line(to: NSPoint(x: 122, y: 40)); p.close() }
        }
        oval(36, 49, 88, 45, light)
        oval(37, 72, 16, 8, pink.withAlphaComponent(0.65)); oval(108, 72, 16, 8, pink.withAlphaComponent(0.65))
        if resting || blink {
            for x: CGFloat in [51, 99] { stroke(width: 2.7) { p in p.move(to: NSPoint(x: x, y: 65)); p.curve(to: NSPoint(x: x + 12, y: 65), controlPoint1: NSPoint(x: x + 3, y: 70), controlPoint2: NSPoint(x: x + 9, y: 70)) } }
        } else {
            for x: CGFloat in [53, 100] { oval(x, 57, 9, 13, ink); oval(x + 2, 59, 3, 4, .white) }
        }
        path(pink) { p in p.move(to: NSPoint(x: 76, y: 73)); p.curve(to: NSPoint(x: 84, y: 73), controlPoint1: NSPoint(x: 74, y: 69), controlPoint2: NSPoint(x: 86, y: 69)); p.line(to: NSPoint(x: 80, y: 77)); p.close() }
        stroke(width: 1.5) { p in p.move(to: NSPoint(x: 80, y: 77)); p.curve(to: NSPoint(x: 72, y: 80), controlPoint1: NSPoint(x: 79, y: 83), controlPoint2: NSPoint(x: 75, y: 83)); p.move(to: NSPoint(x: 80, y: 77)); p.curve(to: NSPoint(x: 88, y: 80), controlPoint1: NSPoint(x: 81, y: 83), controlPoint2: NSPoint(x: 85, y: 83)) }
        // One violet collar and a tiny bell give the silhouette a recognizable accent.
        stroke(NSColor(calibratedRed: 0.64, green: 0.65, blue: 0.92, alpha: 1), width: 5) { p in p.move(to: NSPoint(x: 58, y: 98)); p.curve(to: NSPoint(x: 103, y: 98), controlPoint1: NSPoint(x: 72, y: 103), controlPoint2: NSPoint(x: 91, y: 103)) }
        oval(76, 99, 9, 10, NSColor(calibratedRed: 1, green: 0.84, blue: 0.48, alpha: 1))
        if delivered {
            path(.white, true) { p in p.appendRoundedRect(NSRect(x: 92, y: 99, width: 25, height: 27), xRadius: 4, yRadius: 4) }
            stroke(NSColor(calibratedRed: 0.32, green: 0.64, blue: 0.55, alpha: 1), width: 2.5) { p in p.move(to: NSPoint(x: 98, y: 113)); p.line(to: NSPoint(x: 103, y: 117)); p.line(to: NSPoint(x: 112, y: 107)) }
        }
        nameTag(); context.restoreGState()
    }
    /// C6: two offset interlocking modules, graphite face and mint square eyes.
    /// Native paths keep the contour sharp at desktop and preview sizes.
    private func drawKada() {
        func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor {
            NSColor(calibratedRed: r, green: g, blue: b, alpha: 1)
        }
        func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ radius: CGFloat = 3) -> NSBezierPath {
            NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: radius, yRadius: radius)
        }
        func fill(_ p: NSBezierPath, _ c: NSColor) { c.setFill(); p.fill() }
        func shape(_ points: [(CGFloat, CGFloat)], dx: CGFloat = 0, dy: CGFloat = 0) -> NSBezierPath {
            let pts = points.map { NSPoint(x: $0.0 + dx, y: $0.1 + dy) }
            let p = NSBezierPath(), radius: CGFloat = 3.5
            for i in pts.indices {
                let a = pts[(i + pts.count - 1) % pts.count], b = pts[i], c = pts[(i + 1) % pts.count]
                let incoming = hypot(a.x - b.x, a.y - b.y), outgoing = hypot(c.x - b.x, c.y - b.y)
                let r = min(radius, min(incoming, outgoing) / 2)
                let start = NSPoint(x: b.x + (a.x - b.x) * r / incoming, y: b.y + (a.y - b.y) * r / incoming)
                let end = NSPoint(x: b.x + (c.x - b.x) * r / outgoing, y: b.y + (c.y - b.y) * r / outgoing)
                if i == 0 { p.move(to: start) } else { p.line(to: start) }
                p.curve(to: end, controlPoint1: b, controlPoint2: b)
            }
            p.close(); return p
        }
        func module(_ points: [(CGFloat, CGFloat)], top: NSColor, bottom: NSColor, dx: CGFloat = 0, dy: CGFloat = 0) {
            let p = shape(points, dx: dx, dy: dy)
            fill(shape(points, dx: dx + 3, dy: dy + 4), bottom.blended(withFraction: 0.25, of: .black)!)
            NSGradient(starting: top, ending: bottom)!.draw(in: p, angle: 90)
            NSColor.white.withAlphaComponent(0.18).setStroke(); p.lineWidth = 0.8; p.stroke()
        }
        let graphite = color(0.13, 0.14, 0.18), mint = color(0.72, 0.97, 0.81)
        fill(NSBezierPath(ovalIn: NSRect(x: 25, y: 126, width: 115, height: 7)), graphite.withAlphaComponent(0.12))
        fill(rect(62, 111, 15, 14), graphite); fill(rect(113, 111, 15, 14), graphite)
        // Metallic bridges sit behind the two modules; the face remains visible between them.
        NSGradient(starting: color(0.91, 0.91, 0.92), ending: color(0.49, 0.49, 0.54))!.draw(in: rect(77, 48, 25, 15), angle: 90)
        NSGradient(starting: color(0.85, 0.85, 0.88), ending: color(0.46, 0.46, 0.51))!.draw(in: rect(57, 95, 28, 15), angle: 90)
        fill(rect(49, 61, 62, 38, 5), graphite)
        let shift: CGFloat = resting ? -2 : 0
        module([(34,30),(69,30),(69,47),(88,47),(88,62),(54,62),(54,91),(70,91),(70,107),(34,107),(34,91),(18,91),(18,48),(34,48)],
               top: color(0.51,0.30,0.80), bottom: color(0.34,0.16,0.62), dx: shift)
        module([(103,59),(122,59),(122,76),(140,76),(140,113),(73,113),(73,97),(91,97),(91,59)],
               top: color(0.88,0.81,0.96), bottom: color(0.74,0.63,0.86), dx: -shift)
        // Slow blinking and a narrower focused gaze; work never starts a continuous animation.
        let eyeHeight: CGFloat = blink ? 2 : resting ? 5 : 9
        for x: CGFloat in [64, 83] {
            let eye = rect(x, 72 + (9 - eyeHeight) / 2, 9, eyeHeight, 1.3)
            let glow = NSShadow(); glow.shadowColor = mint.withAlphaComponent(0.28); glow.shadowBlurRadius = 4
            NSGraphicsContext.saveGraphicsState(); glow.set(); fill(eye, mint); NSGraphicsContext.restoreGraphicsState()
        }
        if delivered {
            fill(rect(130, 97, 20, 6, 2), color(0.79,0.69,0.91))
            let paper = shape([(133,79),(150,79),(156,85),(156,99),(133,99)])
            fill(paper, color(0.98,0.98,1))
            color(0.38,0.31,0.55).withAlphaComponent(0.45).setStroke(); paper.lineWidth = 0.8; paper.stroke()
            let check = NSBezierPath(); check.move(to: NSPoint(x: 138,y: 90)); check.line(to: NSPoint(x: 142,y: 94)); check.line(to: NSPoint(x: 151,y: 85))
            color(0.25,0.62,0.48).setStroke(); check.lineWidth = 2; check.lineCapStyle = .round; check.stroke()
        }
    }

}

@MainActor private final class PetAppearanceEditor: ObservableObject {
    @Published var draft: PetAppearance
    @Published var importedImage: Data?
    @Published var error: String?
    init(_ value: PetAppearance) { draft = value }
    func importPicture(_ url: URL) {
        do { importedImage = try PetPicture.read(url); draft.look = .custom; error = nil }
        catch { self.error = error.localizedDescription }
    }
    func choosePicture() {
        let panel = NSOpenPanel()
        panel.title = "选择你的宠物造型"; panel.prompt = "用这张图片"
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.png, .jpeg, .webP, .heic, .heif]
        if panel.runModal() == .OK, let url = panel.url { importPicture(url) }
    }
}

private struct PetPreview: NSViewRepresentable {
    let appearance: PetAppearance
    var picture: NSImage?
    func makeNSView(context: Context) -> CompanionView {
        let view = CompanionView(frame: NSRect(x: 0, y: 0, width: 160, height: 146))
        view.animates = false; view.showsName = false
        return view
    }
    func updateNSView(_ view: CompanionView, context: Context) {
        if view.petAppearance != appearance { view.petAppearance = appearance }
        if view.customPicture !== picture { view.customPicture = picture }
    }
}

private struct PetPersonalization: View {
    @ObservedObject var model: PetModel
    @ObservedObject var editor: PetAppearanceEditor
    let close: () -> Void
    let save: () -> Void
    @FocusState private var nameFocused: Bool
    private var picture: NSImage? {
        if let data = editor.importedImage { return NSImage(data: data) }
        return editor.draft.imageFile == nil ? nil : model.customPicture
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("你的桌面伙伴").font(.system(size: 20, weight: .semibold, design: .rounded))
                    Text("一个喜欢的名字，一个喜欢的样子。").font(.system(size: 12)).foregroundColor(Palette.muted)
                }
                Spacer()
                Button(action: close) { Image(systemName: "xmark").frame(width: 24, height: 24) }.buttonStyle(.plain).accessibilityLabel("取消外观设置")
            }
            HStack(spacing: 14) {
                PetPreview(appearance: editor.draft, picture: picture).frame(width: 100, height: 92).allowsHitTesting(false)
                VStack(alignment: .leading, spacing: 7) {
                    Text("叫我什么？").font(.system(size: 12, weight: .medium))
                    TextField("给伙伴起个名字", text: $editor.draft.name).textFieldStyle(.roundedBorder).focused($nameFocused)
                        .accessibilityLabel("宠物名字")
                    Text("1—20个字，也可以用表情").font(.system(size: 11)).foregroundColor(Palette.muted)
                }
            }.padding(.vertical, 2)
            VStack(alignment: .leading, spacing: 8) {
                Text("选个造型").font(.system(size: 12, weight: .medium))
                HStack(spacing: 8) {
                    ForEach([PetLook.kada, .cat, .rabbit, .bear], id: \.self) { look in
                        Button { editor.draft.look = look; editor.error = nil } label: {
                            VStack(spacing: 3) {
                                PetPreview(appearance: PetAppearance(name: editor.draft.name, look: look)).frame(width: 70, height: 63).allowsHitTesting(false)
                                Text(look.title).font(.system(size: 12, weight: editor.draft.look == look ? .semibold : .regular))
                            }.frame(maxWidth: .infinity).padding(.vertical, 7)
                                .background(editor.draft.look == look ? Palette.wash : Color.white, in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(editor.draft.look == look ? Palette.blue : Palette.line, lineWidth: editor.draft.look == look ? 2 : 1))
                        }.buttonStyle(.plain).accessibilityLabel("选择\(look.title)")
                    }
                }
            }
            HStack(spacing: 10) {
                Button {
                    if picture != nil { editor.draft.look = .custom; editor.error = nil }
                    else { editor.choosePicture() }
                } label: {
                    HStack(spacing: 10) {
                        Group {
                            if let picture = picture { Image(nsImage: picture).resizable().scaledToFit() }
                            else { Image(systemName: "photo").font(.system(size: 20)).foregroundColor(Palette.muted) }
                        }.frame(width: 38, height: 38)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("自己的图片").font(.system(size: 12, weight: .medium))
                            Text(editor.draft.look == .custom ? "已经选好这个造型" : "也可以让喜欢的角色陪你").font(.system(size: 10)).foregroundColor(Palette.muted)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
                Button(picture == nil ? "导入" : "换一张") { editor.choosePicture() }.buttonStyle(PetButton(primary: false))
            }.padding(10).background(Palette.wash.opacity(0.4), in: RoundedRectangle(cornerRadius: 13))
                .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(editor.draft.look == .custom ? Palette.blue : Palette.line, lineWidth: editor.draft.look == .custom ? 2 : 1))
            Text("PNG、JPG、WebP或HEIC，10MB以内。\n透明背景更好看；自定义图片作为静态造型。").font(.system(size: 11)).foregroundColor(Palette.muted)
            Text(editor.error ?? "保存后生效，重开也会记住。").font(.system(size: 11))
                .foregroundColor(editor.error == nil ? Palette.muted : Color(red: 0.64, green: 0.28, blue: 0.25)).frame(minHeight: 28, alignment: .topLeading)
            HStack {
                Button("恢复默认") { editor.draft = .original; editor.importedImage = nil; editor.error = nil }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                Button("取消", action: close).buttonStyle(PetButton(primary: false)).keyboardShortcut(.escape, modifiers: [])
                Button("保存", action: save).buttonStyle(PetButton()).keyboardShortcut(.return, modifiers: .command)
            }
        }.padding(22).frame(width: 380).foregroundColor(Palette.ink)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 23))
            .overlay(RoundedRectangle(cornerRadius: 23).strokeBorder(Palette.line, lineWidth: 1))
            .padding(12).preferredColorScheme(.light).onAppear { nameFocused = true }
    }
}

private final class PetPanel: NSPanel {
    private(set) var frameSetRequests = 0
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        frameSetRequests += 1
        super.setFrame(frameRect, display: flag)
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor private final class PetDelegate: NSObject, NSApplicationDelegate {
    let model: PetModel
    private var pet: NSPanel!
    private var bubble: PetPanel!
    private var cat: CompanionView!
    private var statusItem: NSStatusItem!
    private var observations = Set<AnyCancellable>()
    private var nativeMenu: NSMenu?
    private var personalization: NSPanel?
    private var appearanceEditor: PetAppearanceEditor?
    private var restoreBubbleAfterSettings = false
    init(_ configuration: LaunchConfiguration, appearanceDirectory: URL) { model = PetModel(configuration, appearanceDirectory: appearanceDirectory); super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        pet = panel(NSSize(width: 160, height: 146), interactive: false)
        pet.title = model.appearance.name
        cat = CompanionView(frame: NSRect(x: 0, y: 0, width: 160, height: 146)); pet.contentView = cat
        cat.press = { [weak self] in self?.toggle() }; cat.showMenu = { [weak self] in self?.showMenu() }; cat.moved = { [weak self] in self?.keepOnScreen(); self?.positionBubble(); self?.savePosition() }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        if let stored = UserDefaults.standard.string(forKey: model.api.configuration.defaultsKey + ".position") {
            pet.setFrameOrigin(NSPointFromString(stored))
        } else { pet.setFrameOrigin(NSPoint(x: visible.maxX - 192, y: visible.minY + 22)) }
        keepOnScreen()
        bubble = panel(NSSize(width: 380, height: model.panelHeight), interactive: true) as? PetPanel
        bubble.title = "和桌面伙伴交谈"
        let hosting = NSHostingView(rootView: PetBubble(model: model, close: { [weak self] in self?.hide() }, menu: { [weak self] in self?.showMenu() }))
        hosting.sizingOptions = []
        bubble.contentView = hosting
        model.showBubble = { [weak self] focus in self?.show(focus: focus) }
        model.hideBubble = { [weak self] in self?.hide() }
        model.objectWillChange.receive(on: RunLoop.main).sink { [weak self] in
            DispatchQueue.main.async { self?.updateAppearance() }
        }.store(in: &observations)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "square.stack.3d.up.fill", accessibilityDescription: "Kada")
        statusItem.button?.target = self; statusItem.button?.action = #selector(statusPressed)
        updateAppearance()
        pet.orderFrontRegardless(); positionBubble(); show(focus: true); model.start()
        if let directory = model.api.configuration.smokeDirectory {
            Task {
                if self.model.api.configuration.appearanceSmokeVerifyOnly == true { await verifyAppearanceReopen(directory) }
                else { await runSmoke(directory) }
            }
        }
    }
    private func panel(_ size: NSSize, interactive: Bool) -> NSPanel {
        let p: NSPanel = interactive ? PetPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false) : NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = .floating; p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; p.isFloatingPanel = true
        return p
    }
    private func screen() -> NSScreen { NSScreen.screens.first { $0.frame.intersects(pet.frame) } ?? NSScreen.main! }
    private func keepOnScreen() {
        let f = screen().visibleFrame
        var origin = pet.frame.origin
        origin.x = min(max(origin.x, f.minX), f.maxX - pet.frame.width)
        origin.y = min(max(origin.y, f.minY), f.maxY - pet.frame.height)
        pet.setFrameOrigin(origin)
    }
    private func savePosition() { UserDefaults.standard.set(NSStringFromPoint(pet.frame.origin), forKey: model.api.configuration.defaultsKey + ".position") }
    private func positionBubble() {
        guard bubble != nil else { return }
        let f = screen().visibleFrame
        let size = NSSize(width: 380, height: model.panelHeight)
        let x = min(max(pet.frame.midX - 302, f.minX + 4), f.maxX - size.width - 4)
        let y = min(pet.frame.maxY - 9, f.maxY - size.height - 4)
        let target = NSRect(x: x, y: max(f.minY + 4, y), width: size.width, height: size.height)
        if !NSEqualRects(bubble.frame, target) { bubble.setFrame(target, display: true) }
    }
    private func updateAppearance() {
        if cat.petAppearance != model.appearance { cat.petAppearance = model.appearance }
        if cat.customPicture !== model.customPicture { cat.customPicture = model.customPicture }
        pet.title = model.appearance.name
        bubble.title = "和\(model.appearance.name)交谈"
        statusItem?.button?.toolTip = "\(model.appearance.name) · 桌面伙伴"
        let resting = model.mode == .working, delivered = model.mode == .delivered
        if cat.resting != resting { cat.resting = resting }
        if cat.delivered != delivered { cat.delivered = delivered }
        positionBubble()
    }
    private func show(focus: Bool) {
        if personalization?.isVisible == true { return }
        pet.orderFrontRegardless(); positionBubble(); bubble.orderFrontRegardless()
        if focus { NSApp.activate(ignoringOtherApps: true); bubble.makeKey() }
    }
    private func hide() { bubble.orderOut(nil) }
    private func toggle() {
        if let settings = personalization { NSApp.activate(ignoringOtherApps: true); settings.makeKeyAndOrderFront(nil); return }
        if bubble.isVisible { hide() } else { show(focus: true) }
    }
    @objc private func statusPressed() { showMenu() }
    private func showMenu() {
        let menu = NSMenu()
        add(menu, "和\(model.appearance.name)说话", #selector(openBubble))
        add(menu, "名字与造型…", #selector(openPersonalization))
        menu.addItem(.separator())
        add(menu, "新的目标", #selector(newGoal))
        add(menu, "本机 Agent 与 Skills…", #selector(openEnvironment))
        let recent = NSMenu(title: "最近任务")
        let recentItem = NSMenuItem(title: "最近任务", action: nil, keyEquivalent: ""); recentItem.submenu = recent; menu.addItem(recentItem)
        recent.addItem(withTitle: "正在读取…", action: nil, keyEquivalent: "")
        Task {
            do {
                let tasks: [PetTaskItem] = try await model.api.request("/v1/tasks")
                recent.removeAllItems()
                if tasks.isEmpty { recent.addItem(withTitle: "还没有任务", action: nil, keyEquivalent: "") }
                for task in tasks.prefix(8) {
                    let prefix = task.status == "completed" ? "✓ " : ""
                    let item = NSMenuItem(title: prefix + String(task.objective.prefix(38)).replacingOccurrences(of: "\n", with: " "), action: #selector(attachTask(_:)), keyEquivalent: "")
                    item.target = self; item.representedObject = task.id; recent.addItem(item)
                }
            } catch { recent.removeAllItems(); recent.addItem(withTitle: "暂时无法读取", action: nil, keyEquivalent: "") }
        }
        if model.task != nil {
            if model.mode == .working { add(menu, "暂停当前任务", #selector(pauseTask)) }
            if ![.delivered, .cancelled].contains(model.mode) { add(menu, "取消当前任务", #selector(cancelTask)) }
            add(menu, "打开输出文件夹", #selector(openFolder))
        }
        add(menu, "重新连接", #selector(reconnect))
        menu.addItem(.separator()); add(menu, "隐藏\(model.appearance.name)", #selector(hidePet)); add(menu, "退出\(model.appearance.name)（后台继续）", #selector(quit))
        nativeMenu = menu
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
    private func add(_ menu: NSMenu, _ title: String, _ selector: Selector) { let item = NSMenuItem(title: title, action: selector, keyEquivalent: ""); item.target = self; menu.addItem(item) }
    @objc private func openBubble() { show(focus: true) }
    @objc private func openPersonalization() {
        if let existing = personalization { NSApp.activate(ignoringOtherApps: true); existing.makeKeyAndOrderFront(nil); return }
        restoreBubbleAfterSettings = bubble.isVisible
        bubble.orderOut(nil)
        let editor = PetAppearanceEditor(model.appearance)
        appearanceEditor = editor
        let window = panel(NSSize(width: 404, height: 580), interactive: true)
        window.title = "名字与造型"
        let host = NSHostingView(rootView: PetPersonalization(model: model, editor: editor, close: { [weak self] in self?.closePersonalization() }, save: { [weak self] in self?.savePersonalization() }))
        host.sizingOptions = []; window.contentView = host
        let visible = screen().visibleFrame
        window.setFrameOrigin(NSPoint(x: min(max(pet.frame.midX - 302, visible.minX + 4), visible.maxX - 408), y: min(max(pet.frame.maxY - 575, visible.minY + 4), visible.maxY - 584)))
        personalization = window
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }
    private func closePersonalization() {
        personalization?.orderOut(nil); personalization = nil; appearanceEditor = nil
        if restoreBubbleAfterSettings || model.mode != .working { show(focus: true) }
    }
    private func savePersonalization() {
        guard let editor = appearanceEditor else { return }
        do { try model.saveAppearance(editor.draft, importedImage: editor.importedImage); updateAppearance(); closePersonalization() }
        catch { editor.error = error.localizedDescription }
    }
    @objc private func newGoal() { model.newGoal() }
    @objc private func attachTask(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { Task { await model.select(id) } } }
    @objc private func pauseTask() { model.control("pause") }
    @objc private func cancelTask() { model.control("cancel") }
    @objc private func openFolder() { model.openFolder() }
    @objc private func reconnect() { Task { do { try await model.api.checkHealth(); model.error = nil; await model.refresh() } catch { model.error = "暂时联系不上本地后台。请重新启动桌面伙伴后重试。" }; show(focus: true) } }
    @objc private func openEnvironment() {
        Task {
            do {
                let environment: PetEnvironment = try await model.api.request("/v1/environment")
                guard environment.enabled, let path = environment.overview else { throw PetError.message("本机环境发现已关闭或暂不可用，可在配置中开启 discovery 后重启。") }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            } catch { model.error = error.localizedDescription; show(focus: false) }
        }
    }
    @objc private func hidePet() { pet.orderOut(nil); hide() }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(focus: true); return true }
    func applicationWillTerminate(_ notification: Notification) { model.stop(); savePosition() }

    // Explicit test configuration only. Uses an isolated local Pi fixture, never a cloud model.
    private func runSmoke(_ directory: String) async {
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let environment: PetEnvironment = try await model.api.request("/v1/environment")
            guard environment.enabled, environment.skills > 0, let overview = environment.overview,
                  FileManager.default.fileExists(atPath: overview) else { throw PetError.message("First-run local discovery must be available through the native client") }
            try await Task.sleep(nanoseconds: 350_000_000)
            try snapshotKada(directory + "/08-kada-states.png")
            try snapshot(directory + "/00-kada-goal.png")
            let appearanceChecks = try await verifyPersonalization(directory)
            var inputChecks = try await verifyInputContinuity()
            try snapshot(directory + "/01-goal.png")
            model.draft = "把资料整理成一份中文摘要，交付 report.md，保留原文件。"
            model.submit()
            try await waitUntil { self.model.mode == .clarify && !self.model.busy }
            guard bubble.isVisible else { throw PetError.message("Clarification must be shown automatically") }
            inputChecks += try await verifyInputContinuity()
            try snapshot(directory + "/02-question.png")
            model.draft = "面向项目同事，控制在一页，保留来源。"
            model.submit()
            try await waitUntil { self.model.mode == .confirm && !self.model.busy }
            guard bubble.isVisible else { throw PetError.message("The exact brief must be visible before consent") }
            try snapshot(directory + "/03-confirm.png")
            guard model.task?.confirmation != nil else { throw PetError.message("Missing native confirmation payload") }
            model.confirm()
            try await waitUntil { self.model.mode == .working && !self.model.busy }
            guard !bubble.isVisible else { throw PetError.message("The bubble must collapse during autonomous execution") }
            try snapshot(directory + "/04-quiet.png", includeBubble: false)
            try await waitUntil { self.model.mode == .delivered && !self.model.busy }
            guard bubble.isVisible else { throw PetError.message("Delivery must be shown automatically") }
            guard let task = model.task, let file = task.delivery?.artifacts.first else { throw PetError.message("Missing delivery") }
            let url = try PetFiles.artifact(file, workspace: task.workspace)
            guard try String(contentsOf: url).contains("来源") else { throw PetError.message("Missing source in actual deliverable") }
            try snapshot(directory + "/05-delivery.png")
            let result: [String: Any] = ["ok": true, "pid": ProcessInfo.processInfo.processIdentifier, "taskId": task.id, "confirmed": task.confirmed, "artifacts": task.delivery?.artifacts ?? [], "screenshots": 9, "quietWhileWorking": true, "nativeInputChecks": inputChecks, "appearanceChecks": appearanceChecks, "petName": model.appearance.name, "environmentReachable": true]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: directory + "/result.json"))
        } catch {
            let failure: [String: Any] = ["ok": false, "error": error.localizedDescription]
            let data = try? JSONSerialization.data(withJSONObject: failure, options: [.prettyPrinted])
            try? data?.write(to: URL(fileURLWithPath: directory + "/result.json"))
        }
        NSApp.terminate(nil)
    }
    private func verifyPersonalization(_ directory: String) async throws -> Int {
        var checks = 0
        model.draft = "尚未发送的目标草稿"
        openPersonalization()
        guard let editor = appearanceEditor else { throw PetError.message("Personalization editor missing") }
        editor.draft.name = "糯米 🐾"; editor.draft.look = .rabbit
        savePersonalization()
        guard model.appearance.name == "糯米 🐾", cat.petAppearance.look == .rabbit, pet.title == "糯米 🐾" else { throw PetError.message("Saved look/name did not reach the desktop pet") }
        checks += 1
        openPersonalization()
        appearanceEditor?.draft.name = "不应保存的名字"; appearanceEditor?.draft.look = .bear
        closePersonalization()
        guard model.appearanceStore.load().name == "糯米 🐾", model.appearanceStore.load().look == .rabbit, model.draft == "尚未发送的目标草稿" else { throw PetError.message("Cancel changed saved preferences or discarded task draft") }
        checks += 1
        openPersonalization()
        appearanceEditor?.draft.name = ""
        savePersonalization()
        guard personalization?.isVisible == true, appearanceEditor?.error != nil, model.appearance.name == "糯米 🐾" else { throw PetError.message("Invalid name was saved or dismissed the editor") }
        checks += 1
        appearanceEditor?.draft.name = "糯米 🐾"; appearanceEditor?.error = nil
        try await Task.sleep(nanoseconds: 200_000_000)
        if let view = personalization?.contentView { try snapshotView(view, path: directory + "/06-personalization.png") }
        let source = URL(fileURLWithPath: directory).appendingPathComponent("temporary-look.png")
        let image = NSImage(size: NSSize(width: 96, height: 96))
        image.lockFocus()
        NSColor.clear.setFill(); NSRect(x: 0, y: 0, width: 96, height: 96).fill(using: .copy)
        NSColor(calibratedRed: 0.60, green: 0.80, blue: 0.73, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 18, y: 9, width: 60, height: 62)).fill()
        NSBezierPath(ovalIn: NSRect(x: 26, y: 49, width: 14, height: 41)).fill()
        NSBezierPath(ovalIn: NSRect(x: 56, y: 49, width: 14, height: 41)).fill()
        NSColor.darkGray.setFill()
        NSBezierPath(ovalIn: NSRect(x: 32, y: 37, width: 6, height: 8)).fill()
        NSBezierPath(ovalIn: NSRect(x: 58, y: 37, width: 6, height: 8)).fill()
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: source)
        appearanceEditor?.importPicture(source)
        appearanceEditor?.draft.name = "米粒"
        savePersonalization()
        try FileManager.default.removeItem(at: source)
        guard model.appearance.look == .custom, model.customPicture != nil, cat.petAppearance.look == .custom else { throw PetError.message("Imported appearance was not applied") }
        checks += 1
        let reopened = PetModel(model.api.configuration, appearanceDirectory: model.appearanceStore.directory)
        guard reopened.appearance == model.appearance, reopened.customPicture != nil else { throw PetError.message("Owned picture/name did not survive reopening preferences") }
        checks += 1
        guard model.task == nil, model.draft == "尚未发送的目标草稿", model.appearanceStore.imageData(for: model.appearance) != nil else { throw PetError.message("Personalization changed task state or depended on the deleted original") }
        checks += 1
        model.draft = ""
        try snapshot(directory + "/07-custom-pet.png")
        return checks
    }
    private func verifyAppearanceReopen(_ directory: String) async {
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            guard model.appearance.name == "米粒", model.appearance.look == .custom, model.customPicture != nil, cat.petAppearance.name == "米粒" else { throw PetError.message("Custom name/look did not survive a real process restart") }
            try JSONSerialization.data(withJSONObject: ["ok": true, "name": model.appearance.name, "look": model.appearance.look.rawValue, "ownedPictureRestored": true]).write(to: URL(fileURLWithPath: directory + "/result-reopen.json"))
        } catch {
            try? JSONSerialization.data(withJSONObject: ["ok": false, "error": error.localizedDescription]).write(to: URL(fileURLWithPath: directory + "/result-reopen.json"))
        }
        NSApp.terminate(nil)
    }
    private func nativeEditor(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView, text.isEditable { return text }
        for child in view.subviews { if let text = nativeEditor(in: child) { return text } }
        return nil
    }
    private func verifyInputContinuity() async throws -> Int {
        guard let editor = nativeEditor(in: bubble.contentView!) else { throw PetError.message("Native input editor is missing") }
        bubble.makeKey(); bubble.makeFirstResponder(editor)
        let before = bubble.frameSetRequests
        let originalTask = model.task?.id
        editor.insertText("帮我整理资料，", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await Task.sleep(nanoseconds: 100_000_000)
        guard model.draft == "帮我整理资料，" else { throw PetError.message("Native edits did not reach the draft") }
        editor.setSelectedRange(NSRange(location: 4, length: 0))
        editor.setMarkedText("baogao", selectedRange: NSRange(location: 6, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        let composition = editor.markedRange(), selection = editor.selectedRange(), text = editor.string
        for index in 0..<4 {
            await model.refresh()
            if index == 1 {
                var changed = model.appearance
                changed.name = changed.name == "米粒" ? "米粒 🐾" : "米粒"
                try model.saveAppearance(changed)
            }
            model.objectWillChange.send()
            try await Task.sleep(nanoseconds: 80_000_000)
        }
        guard bubble.firstResponder === editor else { throw PetError.message("Background refresh interrupted native input focus") }
        guard editor.hasMarkedText(), NSEqualRanges(editor.markedRange(), composition), NSEqualRanges(editor.selectedRange(), selection), editor.string == text else { throw PetError.message("Background refresh replaced IME composition or moved the caret") }
        editor.insertText("报告", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await Task.sleep(nanoseconds: 100_000_000)
        guard !editor.hasMarkedText(), model.draft == "帮我整理报告资料，" else { throw PetError.message("Chinese composition did not commit at the selected caret") }
        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
        editor.insertNewline(nil)
        editor.insertText("English 123", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await Task.sleep(nanoseconds: 100_000_000)
        guard model.draft == "帮我整理报告资料，\nEnglish 123", model.task?.id == originalTask, !model.busy else { throw PetError.message("Multiline native typing changed or prematurely submitted the draft") }
        guard bubble.frameSetRequests == before else { throw PetError.message("Typing and refresh caused \(bubble.frameSetRequests - before) unnecessary native window resets") }
        model.draft = ""
        try await Task.sleep(nanoseconds: 100_000_000)
        return 6
    }
    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<250 {
            if condition() { try await Task.sleep(nanoseconds: 250_000_000); return }
            if let error = model.error { throw PetError.message(error) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw PetError.message("Native UI smoke timed out")
    }
    private func snapshot(_ path: String, includeBubble: Bool = true) throws {
        if includeBubble { show(focus: false) }
        bubble.contentView?.layoutSubtreeIfNeeded(); cat.displayIfNeeded()
        let image = NSImage(size: NSSize(width: 410, height: bubble.frame.height + 150))
        image.lockFocus()
        NSColor(calibratedRed: 0.91, green: 0.94, blue: 0.98, alpha: 1).setFill()
        NSRect(origin: .zero, size: image.size).fill()
        var views: [(NSView, NSPoint)] = [(cat as NSView, NSPoint(x: 230, y: 4))]
        if includeBubble { views.insert((bubble.contentView!, NSPoint(x: 14, y: 144)), at: 0) }
        for (view, point) in views {
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw PetError.message("Cannot render native view") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            NSImage(cgImage: bitmap.cgImage!, size: view.bounds.size).draw(at: point, from: .zero, operation: .sourceOver, fraction: 1)
        }
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { throw PetError.message("Cannot encode native snapshot") }
        try data.write(to: URL(fileURLWithPath: path))
    }
    private func snapshotKada(_ path: String) throws {
        let image = NSImage(size: NSSize(width: 480, height: 180))
        image.lockFocus()
        NSColor(calibratedRed: 0.96, green: 0.95, blue: 0.98, alpha: 1).setFill()
        NSRect(origin: .zero, size: image.size).fill()
        for (index, label) in ["待机", "工作", "交付"].enumerated() {
            let view = CompanionView(frame: NSRect(x: 0, y: 0, width: 160, height: 146))
            view.animates = false; view.showsName = false
            view.resting = index == 1; view.delivered = index == 2
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw PetError.message("Cannot render Kada state") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            NSImage(cgImage: bitmap.cgImage!, size: view.bounds.size).draw(in: NSRect(x: index * 160, y: 24, width: 160, height: 146))
            let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
            NSAttributedString(string: label, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.darkGray, .paragraphStyle: paragraph])
                .draw(in: NSRect(x: index * 160, y: 8, width: 160, height: 20))
        }
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { throw PetError.message("Cannot encode Kada states") }
        try data.write(to: URL(fileURLWithPath: path))
    }
    private func snapshotView(_ view: NSView, path: String) throws {
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw PetError.message("Cannot render native personalization view") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { throw PetError.message("Cannot encode personalization view") }
        try data.write(to: URL(fileURLWithPath: path))
    }
}

@main private struct PetApplication {
    @MainActor static func main() {
        do {
            let configurationURL: URL
            if let argument = CommandLine.arguments.firstIndex(of: "--configuration"), CommandLine.arguments.count > argument + 1 {
                configurationURL = URL(fileURLWithPath: CommandLine.arguments[argument + 1])
            } else {
                let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                configurationURL = support.appendingPathComponent("Local Pi Pet").appendingPathComponent(Bundle.main.bundleIdentifier ?? "unknown").appendingPathComponent("connection.json")
                guard FileManager.default.fileExists(atPath: configurationURL.path) else { throw PetError.message("请先通过 npm run pet 启动桌面小伙伴。") }
            }
            let data = try Data(contentsOf: configurationURL)
            let configuration = try JSONDecoder().decode(LaunchConfiguration.self, from: data)
            let app = NSApplication.shared
            let delegate = PetDelegate(configuration, appearanceDirectory: configurationURL.deletingLastPathComponent().appendingPathComponent("appearance"))
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
    }
}
