import AppKit
import SwiftUI

/** Keep AppKit's text storage and IME session alive across SwiftUI/polling updates. */
struct PetDraftInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let label: String
    let focusRequest: Int
    var submit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true; scroll.scrollerStyle = .overlay
        scroll.contentView.drawsBackground = false
        let editor = DraftTextView(frame: .zero)
        editor.isRichText = false; editor.drawsBackground = false; editor.allowsUndo = true
        editor.isEditable = true; editor.isSelectable = true
        editor.font = .systemFont(ofSize: 13)
        editor.textColor = NSColor(calibratedRed: 0.17, green: 0.20, blue: 0.32, alpha: 1)
        editor.insertionPointColor = NSColor(calibratedRed: 0.40, green: 0.47, blue: 0.81, alpha: 1)
        editor.textContainerInset = NSSize(width: 5, height: 6)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
        editor.delegate = context.coordinator
        editor.string = text
        editor.focusChanged = { [weak coordinator = context.coordinator] value in
            DispatchQueue.main.async {
                guard let coordinator = coordinator, coordinator.parent.focused != value else { return }
                coordinator.parent.focused = value
            }
        }
        editor.submit = { [weak coordinator = context.coordinator] in coordinator?.parent.submit() }
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? DraftTextView else { return }
        editor.setAccessibilityLabel(label)
        // Marked text is owned by the input method. Never replace it with a stale binding.
        if !editor.hasMarkedText(), editor.string != text {
            let selection = editor.selectedRange()
            context.coordinator.applyingValue = true
            editor.string = text
            let length = (text as NSString).length
            let location = min(selection.location, length)
            editor.setSelectedRange(NSRange(location: location, length: min(selection.length, length - location)))
            context.coordinator.applyingValue = false
        }
        if context.coordinator.focusRequest != focusRequest {
            context.coordinator.focusRequest = focusRequest
            DispatchQueue.main.async { [weak editor] in
                guard let editor = editor, let window = editor.window,
                      window.isKeyWindow, NSApp.isActive, window.firstResponder !== editor else { return }
                window.makeFirstResponder(editor)
            }
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PetDraftInput
        var applyingValue = false
        var focusRequest: Int?
        init(_ parent: PetDraftInput) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard !applyingValue, let editor = notification.object as? NSTextView else { return }
            if parent.text != editor.string { parent.text = editor.string }
        }
    }
}

private final class DraftTextView: NSTextView {
    var focusChanged: ((Bool) -> Void)?
    var submit: (() -> Void)?
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { focusChanged?(true) }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { focusChanged?(false) }
        return accepted
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.type == .keyDown, event.keyCode == 36,
           event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command {
            // The first chord commits a composing phrase; it must not submit half a goal.
            if hasMarkedText() { unmarkText(); didChangeText() }
            else { submit?() }
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}
