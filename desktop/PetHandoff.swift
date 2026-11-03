import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Shared by the handoff and existing appearance controls; the C6 artwork keeps its original colors.
enum Palette {
    static func native(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(calibratedRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        }
    }
    static let textColor = native(0x282430, 0xf2eef7)
    static let actionColor = native(0x69518e, 0xc2a9e9)
    static let ink = Color(nsColor: textColor)
    static let muted = Color(nsColor: native(0x706879, 0xbdb3c8))
    static let blue = Color(nsColor: actionColor)
    static let onBlue = Color(nsColor: native(0xffffff, 0x281d36))
    static let surface = Color(nsColor: native(0xfdfcfe, 0x28242f))
    static let wash = Color(nsColor: native(0xf3f0f7, 0x342e3e))
    static let line = Color(nsColor: native(0xe5dfea, 0x4a4057))
    static let inputLine = Color(nsColor: native(0x9a8da6, 0x8e7d9f))
    static let error = Color(nsColor: native(0x923d36, 0xf2b8af))
    static let shadow = Color(nsColor: native(0x302139, 0x08040d))
}

struct PetButton: ButtonStyle {
    var primary = true
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduced
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 14, weight: .medium))
            .padding(.horizontal, 15).frame(minHeight: 42)
            .foregroundColor(primary ? Palette.onBlue : Palette.ink)
            .background(primary ? Palette.blue : Palette.wash, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(reduced ? nil : .easeOut(duration: 0.08), value: configuration.isPressed)
            .opacity(enabled ? 1 : 0.42)
    }
}

struct PetBubble: View {
    @ObservedObject var model: PetModel
    var close: () -> Void
    var menu: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var focused = false
    @State private var focusRequest = 0
    @State private var entered = false
    @State private var dropTarget = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if let error = model.error, !model.showingMemory {
                HStack(alignment: .top, spacing: 10) {
                    Text(error).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button("重试") { model.retry() }.buttonStyle(.plain).accessibilityLabel("保留当前输入并重试")
                }.font(.system(size: 13)).foregroundColor(Palette.error)
                    .padding(12).background(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.error.opacity(0.5)))
                    .padding(.horizontal, 22).padding(.bottom, 14)
            }
            ZStack(alignment: .topLeading) {
                content.opacity(model.showingMemory ? 0 : 1)
                    .allowsHitTesting(!model.showingMemory).accessibilityHidden(model.showingMemory)
                    .disabled(model.showingMemory)
                if model.showingMemory { memoryContent.transition(.opacity) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .foregroundColor(Palette.ink).font(.system(size: 14))
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Palette.line, lineWidth: 1))
        .compositingGroup()
        .shadow(color: Palette.shadow.opacity(0.07), radius: 15, y: 8)
        .shadow(color: Palette.shadow.opacity(0.05), radius: 3, y: 1)
        .padding(12)
        .onAppear { entered = true; focusInput() }
        .onChange(of: model.task?.status) { _ in focusInput() }
        .onChange(of: model.editing) { _ in focusInput() }
        .onChange(of: model.showingMemory) { showing in if !showing { focusInput() } }
        .onExitCommand {
            if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.hasMarkedText() { return }
            if model.showingMemory { model.showingMemory = false }
            else if model.resumePrompt { model.resumePrompt = false }
            else if model.editing { model.editing = false }
            else { close() }
        }
    }
    private func focusInput() {
        if !model.showingMemory && (model.mode == nil || model.mode == .chat || model.mode == .clarify || model.mode == .attention || model.editing) { focusRequest += 1 }
    }
    private var header: some View {
        HStack(spacing: 8) {
            if model.showingMemory {
                Button { model.showingMemory = false } label: { Image(systemName: "arrow.left").frame(width: 28, height: 32) }
                    .buttonStyle(.plain).accessibilityLabel("返回当前工作")
            }
            Text(model.appearance.name).font(.system(size: 15, weight: .medium))
            Text(model.stateLabel).font(.system(size: 13)).foregroundColor(Palette.muted)
            Spacer(minLength: 4)
            Button(action: menu) { Image(systemName: "ellipsis").frame(width: 32, height: 32) }
                .buttonStyle(.plain).help("最近对话、记忆与设置").accessibilityLabel("更多")
            Button(action: close) { Image(systemName: "minus").frame(width: 32, height: 32) }
                .buttonStyle(.plain).help("收起，当前输入和任务会保留").accessibilityLabel("收起气泡")
        }.foregroundColor(Palette.ink).padding(.horizontal, 22).frame(height: 60)
    }
    @ViewBuilder private var content: some View {
        switch model.mode {
        case nil: compose
        case .chat: conversation
        case .confirm: if model.editing { editBrief } else { confirmation }
        case .clarify: clarification
        case .working: working
        case .delivered: delivery
        case .paused, .budget, .attention: attention
        case .cancelled: cancelled
        }
    }
    private var compose: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                companion.frame(width: 64, height: 88)
                    .opacity(entered ? 1 : 0).offset(y: entered ? 0 : 5)
                    .animation(reduced ? nil : .easeOut(duration: 0.26), value: entered)
                VStack(spacing: 12) {
                    editor("想到什么，直接说。\n要做的事也可以交给我。", height: 88)
                    attachments
                    HStack {
                        addFilesButton
                        Spacer(minLength: 4)
                        sendButton("交给 " + model.appearance.name)
                    }
                }.opacity(entered ? 1 : 0)
                    .animation(reduced ? nil : .easeOut(duration: 0.26).delay(0.05), value: entered)
            }.padding(.top, 14)
            Spacer(minLength: 20)
            Button { model.openMemory() } label: {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2).fill(Palette.blue).frame(width: 5, height: 5)
                    Text("我对你的了解")
                    Spacer()
                    Text("查看记忆")
                    Image(systemName: "chevron.right").font(.system(size: 11))
                }.font(.system(size: 13)).foregroundColor(Palette.muted).padding(.vertical, 18)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("查看我对你的了解与来源")
                .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1) }
        }.padding(.horizontal, 22)
            .onDrop(of: [UTType.fileURL.identifier], isTargeted: $dropTarget, perform: acceptDrop)
            .background(dropTarget ? Palette.wash : Color.clear)
    }
    private var conversation: some View {
        VStack(alignment: .leading, spacing: 20) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(model.task?.reply?.text ?? "正在回复…").font(.system(size: 15)).lineSpacing(7)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    if ["running", "pending"].contains(model.task?.status ?? ""), model.task?.reply != nil {
                        Text("正在回复…").font(.system(size: 13)).foregroundColor(Palette.muted)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            editor("接着聊，或交给我一件事…", height: 66)
            attachments
            HStack { addFilesButton; Spacer(); sendButton("发送") }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var confirmation: some View {
        VStack(alignment: .leading, spacing: 18) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    heading(model.taskTitle)
                    if let brief = model.task?.brief {
                        briefRow("交付", brief.deliverables)
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(brief.criteria.enumerated()), id: \.offset) { index, criterion in
                                briefRow(index == 0 ? "标准" : "", [criterion.text, criterion.method == "check" ? "以约定命令核验" : "内容采用自检"])
                                if let check = criterion.verification {
                                    Text("核对命令：\(check.command)\n固定输入：\(check.inputs.joined(separator: "、"))\n核对产物：\(check.outputs.joined(separator: "、"))")
                                        .font(.system(size: 13)).foregroundColor(Palette.muted).textSelection(.enabled)
                                }
                            }
                        }
                        briefRow("范围", brief.inputs + brief.scope)
                        if !brief.assumptions.isEmpty { briefRow("限制", brief.assumptions) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 5)
            }
            if let budget = model.task?.brief?.budget { budgetSummary(budget) }
            HStack {
                Button("调整约定") { model.beginEdit() }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                Button { model.confirm() } label: { Label("确认并开始", systemImage: "arrow.right") }
                    .buttonStyle(PetButton()).disabled(model.busy || model.task?.confirmation == nil)
            }.font(.system(size: 13))
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var editBrief: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("调整这一次交付")
            Text("想调整哪些目标或标准？").font(.system(size: 13)).foregroundColor(Palette.muted)
            editor("写下要调整的地方，其他约定保留。", height: 114)
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("总费用上限（美元）").font(.system(size: 13)).foregroundColor(Palette.muted)
                    TextField("0.25", text: $model.editCost).font(.system(size: 16)).textFieldStyle(.roundedBorder).accessibilityLabel("总费用上限（美元）")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("执行时限（分钟）").font(.system(size: 13)).foregroundColor(Palette.muted)
                    TextField("15", text: $model.editMinutes).font(.system(size: 16)).textFieldStyle(.roundedBorder).accessibilityLabel("执行时限（分钟）")
                }
            }
            Text("更新后会展示新版约定，确认前不会开始执行。").font(.system(size: 13)).foregroundColor(Palette.muted)
            attachments
            Spacer(minLength: 0)
            HStack {
                Button("保留原约定") { model.editing = false }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                sendButton("更新约定")
            }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var clarification: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("还差一项资料")
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    let questions = model.task?.brief?.questions ?? []
                    if questions.isEmpty { Text(model.task?.question ?? "请补充影响结果的必要信息。") }
                    else { ForEach(Array(questions.enumerated()), id: \.offset) { _, text in Text(text) } }
                }.lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
            editor("补充说明，或添加所需资料…", height: 88)
            attachments
            HStack { addFilesButton; Spacer(); sendButton("补充并继续") }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var working: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                companion.frame(width: 70, height: 78)
                VStack(alignment: .leading, spacing: 7) {
                    Text(model.taskTitle).font(.system(size: 18, weight: .medium)).lineLimit(2).help(model.taskTitle)
                    Text(model.task?.confirmed == false ? "正在整理交付约定" : "正在推进任务").font(.system(size: 13)).foregroundColor(Palette.muted)
                }
            }
            Text("你可以先忙别的。完成后，文件会留在这里。").foregroundColor(Palette.muted).lineSpacing(5)
            Spacer(minLength: 0)
            HStack {
                Button("暂停") { model.control("pause") }.buttonStyle(.plain).foregroundColor(Palette.muted).disabled(model.busy)
                Spacer()
                Button("收起，等结果", action: close).buttonStyle(PetButton())
            }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var delivery: some View {
        VStack(alignment: .leading, spacing: 18) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    heading(model.taskTitle)
                    if model.task?.delivery?.artifacts.isEmpty == true {
                        Text(model.task?.delivery?.summary ?? "").font(.system(size: 15)).lineSpacing(7).textSelection(.enabled)
                    }
                    VStack(spacing: 8) {
                        ForEach(Array((model.task?.delivery?.artifacts ?? []).enumerated()), id: \.offset) { index, path in
                            artifactRow(path, primary: index == 0)
                        }
                    }
                    DisclosureGroup("核验范围与交付说明") {
                        VStack(alignment: .leading, spacing: 12) {
                            if model.task?.delivery?.artifacts.isEmpty == false { Text(model.task?.delivery?.summary ?? "") }
                            Text(model.task?.delivery?.verification ?? "")
                            ForEach(model.task?.delivery?.assumptions ?? [], id: \.self) { Text($0) }
                        }.font(.system(size: 13)).lineSpacing(5).padding(.top, 10)
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.font(.system(size: 13)).foregroundColor(Palette.muted).tint(Palette.muted)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 3)
            }
            HStack {
                Button("新的目标") { model.newGoal() }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                Text("本次估算 $\(PetBudget.money(model.task?.budget.estimatedCostUsd ?? 0))").foregroundColor(Palette.muted)
            }.font(.system(size: 13))
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var attention: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading(model.resumePrompt ? "这次追加多少" : model.taskTitle)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let detail = model.task?.question ?? model.task?.reason { Text(detail) }
                    else if model.mode == .attention { Text("请补充影响结果的必要说明。") }
                    if model.mode != .attention {
                        Text(model.resumeMessage).foregroundColor(Palette.muted)
                        if !model.resumePrompt { Text("继续前，先确认要追加的预算。").foregroundColor(Palette.muted) }
                    }
                }.lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
            if model.mode == .attention {
                editor("补充材料或调整要求…", height: 88)
                attachments
                HStack { addFilesButton; Spacer(); sendButton("发送说明") }
            } else if model.resumePrompt {
                HStack {
                    Button("保持暂停") { model.resumePrompt = false }.buttonStyle(.plain).foregroundColor(Palette.muted)
                    Spacer()
                    Button("追加并继续") { model.control("resume") }.buttonStyle(PetButton()).disabled(model.busy)
                }
            } else {
                HStack {
                    Button("新的目标") { model.newGoal() }.buttonStyle(.plain).foregroundColor(Palette.muted)
                    Spacer()
                    Button("查看追加预算") { model.resumePrompt = true }.buttonStyle(PetButton()).disabled(model.busy)
                }
            }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var cancelled: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading(model.taskTitle)
            Text("已有文件保留在原来的位置。").foregroundColor(Palette.muted)
            Spacer()
            HStack {
                Button("打开文件夹") { model.openFolder() }.buttonStyle(.plain).foregroundColor(Palette.muted)
                Spacer()
                Button("新的目标") { model.newGoal() }.buttonStyle(PetButton())
            }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
    }
    private var memoryContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading("我对你的了解")
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error = model.memoryError {
                        Text(error).foregroundColor(Palette.error)
                        Button("重新读取") { model.openMemory() }.buttonStyle(PetButton())
                    } else if let memory = model.memory {
                        if !memory.enabled {
                            Text("工作记忆已关闭").font(.system(size: 16, weight: .medium))
                            Text("在本机配置中开启 discovery 后重启后台，即可读取已有工作线索。").foregroundColor(Palette.muted)
                        } else if memory.facts.isEmpty {
                            Text("还没有可用的工作线索。").foregroundColor(Palette.muted)
                            Text("你可以直接开始，后续交流中的明确偏好会逐步整理进来。").foregroundColor(Palette.muted)
                        }
                        ForEach(memory.facts) { fact in
                            VStack(alignment: .leading, spacing: 9) {
                                Text(fact.text).lineSpacing(6).textSelection(.enabled)
                                DisclosureGroup(fact.sourceLabel) {
                                    VStack(alignment: .leading, spacing: 12) {
                                        ForEach(Array(fact.evidence.enumerated()), id: \.offset) { _, source in
                                            VStack(alignment: .leading, spacing: 8) {
                                                Text(source.quote).lineSpacing(5)
                                                Text(source.path).textSelection(.enabled)
                                                Text("观察于 " + Date(timeIntervalSince1970: source.observedAt / 1000).formatted(date: .abbreviated, time: .shortened))
                                            }.textSelection(.enabled)
                                        }
                                    }.padding(.top, 8)
                                }.font(.system(size: 13)).foregroundColor(Palette.muted).tint(Palette.muted)
                            }
                            Rectangle().fill(Palette.line).frame(height: 1)
                        }
                        ForEach(memory.notices, id: \.self) { Text($0).font(.system(size: 13)).foregroundColor(Palette.muted) }
                    }
                    if model.memoryLoading { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在读取工作记忆…") }.foregroundColor(Palette.muted) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 5)
            }
            HStack { Spacer(); Button("回到当前工作") { model.showingMemory = false }.buttonStyle(PetButton()) }
        }.padding([.horizontal, .bottom], 24).padding(.top, 10)
            .background(Palette.surface)
    }
    private var companion: some View {
        PetPreview(appearance: model.appearance, picture: model.customPicture, resting: model.mode == .working, delivered: model.mode == .delivered)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
    private func heading(_ title: String) -> some View {
        Text(title).font(.system(size: 22, weight: .medium)).lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func briefRow(_ label: String, _ values: [String]) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text(label).font(.system(size: 13)).foregroundColor(Palette.muted).frame(width: 30, alignment: .leading).padding(.top, 1)
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in Text(value).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
            }.lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func budgetSummary(_ budget: PetBudget) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) { Text("总费用上限").font(.system(size: 13)).foregroundColor(Palette.muted); Text("$" + PetBudget.money(budget.maxEstimatedCostUsd)).font(.system(size: 22)).monospacedDigit() }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 5) { Text("执行时限").font(.system(size: 13)).foregroundColor(Palette.muted); Text("\(max(1, Int(ceil(budget.maxDurationMs / 60000)))) 分钟").font(.system(size: 22)).monospacedDigit() }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.top, 5)
            Text("费用含准备消耗，已用约 $\(PetBudget.money(model.task?.budget.estimatedCostUsd ?? 0))。时限从确认起计，到上限会暂停，追加前会请你确认。")
                .font(.system(size: 13)).foregroundColor(Palette.muted).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            if let tokens = budget.maxTotalTokens { Text("累计 token 上限 \(tokens)").font(.system(size: 13)).foregroundColor(Palette.muted) }
        }
    }
    private func artifactRow(_ path: String, primary: Bool) -> some View {
        Button { model.openArtifact(path) } label: {
            HStack(spacing: 14) {
                Image(systemName: "doc.text").font(.system(size: 25, weight: .light)).foregroundColor(Palette.blue).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text((path as NSString).lastPathComponent).font(.system(size: 15, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    if path != (path as NSString).lastPathComponent {
                        Text(path).font(.system(size: 13)).foregroundColor(Palette.muted).lineLimit(2)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Palette.blue)
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(primary ? Palette.wash : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).help(path).accessibilityLabel("打开产物 \(path)")
    }
    private func editor(_ placeholder: String, height: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            if model.draft.isEmpty { Text(placeholder).font(.system(size: 17)).lineSpacing(7).foregroundColor(Palette.muted).padding(.top, 2).allowsHitTesting(false) }
            PetDraftInput(text: $model.draft, focused: $focused, label: placeholder, focusRequest: focusRequest, submit: { model.submit() })
        }.frame(height: height)
            .overlay(alignment: .bottom) { Rectangle().fill(focused ? Palette.blue : Palette.inputLine).frame(height: 1) }
    }
    private var addFilesButton: some View {
        Button { model.addFiles() } label: { Label("资料", systemImage: "plus").font(.system(size: 13)).frame(minHeight: 32) }
            .buttonStyle(.plain).foregroundColor(Palette.muted)
    }
    private var attachments: some View {
        Group {
            if !model.attachments.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.attachments, id: \.path) { url in
                            HStack(spacing: 8) {
                                Text(url.lastPathComponent).lineLimit(1).help(url.path)
                                Spacer(minLength: 0)
                                Button { model.attachments.removeAll { $0 == url } } label: { Image(systemName: "xmark").frame(width: 24, height: 24) }
                                    .buttonStyle(.plain).accessibilityLabel("移除 \(url.lastPathComponent)")
                            }.font(.system(size: 13)).padding(.horizontal, 8).background(Palette.wash, in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }.frame(height: min(64, CGFloat(model.attachments.count) * 30))
            }
        }
    }
    private func sendButton(_ label: String) -> some View {
        Button { model.submit() } label: {
            HStack(spacing: 8) { Text(model.busy ? "正在发送…" : model.error == nil ? label : "重试"); Image(systemName: "arrow.up").font(.system(size: 12)) }
        }.buttonStyle(PetButton()).disabled(model.busy || (!model.editing && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            .keyboardShortcut(.return, modifiers: .command).help("⌘ ↵")
    }
    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        for provider in providers {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, _ in
                let url = (value as? URL) ?? (value as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                if let url = url, url.isFileURL { DispatchQueue.main.async { if !model.attachments.contains(url) { model.attachments.append(url) } } }
            }
        }
        return !providers.isEmpty
    }
}

struct PetDock: View {
    @ObservedObject var model: PetModel
    let expand: () -> Void
    let moved: () -> Void
    let menu: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            PetPreview(appearance: model.appearance, picture: model.customPicture, resting: model.mode == .working, delivered: model.mode == .delivered, press: expand, moved: moved, menu: menu)
                .frame(width: 68, height: 68)
            Button(action: expand) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.task == nil ? model.appearance.name : model.taskTitle).font(.system(size: 14, weight: .medium)).lineLimit(2)
                        Text(model.dockStatus).font(.system(size: 13)).foregroundColor(Palette.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Text(model.mode == .delivered ? "查看交付" : "展开").font(.system(size: 13)).foregroundColor(Palette.blue)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).help(model.taskTitle).accessibilityLabel("展开 \(model.taskTitle)，\(model.dockStatus)")
        }.padding(.leading, 4).padding(.trailing, 16).padding(.vertical, 4)
            .foregroundColor(Palette.ink).background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line, lineWidth: 1))
            .compositingGroup()
            .shadow(color: Palette.shadow.opacity(0.09), radius: 10, y: 5).padding(10)
    }
}
