import AppKit
import Foundation
import PDFKit
import Vision

struct PageOCR: Codable {
    let page: Int
    let characterCount: Int
    let averageConfidence: Float
    let text: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func render(page: PDFPage, scale: CGFloat) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let width = max(1, Int(bounds.width * scale))
    let height = max(1, Int(bounds.height * scale))
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return nil }

    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    return context.makeImage()
}

func recognize(image: CGImage) throws -> (String, Float) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let candidates = observations.compactMap { observation -> (String, Float)? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return (candidate.string, candidate.confidence)
    }
    let text = candidates.map(\.0).joined(separator: "\n")
    let confidence = candidates.isEmpty
        ? 0
        : candidates.reduce(Float(0)) { $0 + $1.1 } / Float(candidates.count)
    return (text, confidence)
}

let arguments = CommandLine.arguments
guard arguments.count == 6 else {
    fail("usage: ocr-pdf-vision <input.pdf> <output-dir> <start-page> <end-page> <scale>")
}

let inputPath = arguments[1]
let outputDirectory = URL(fileURLWithPath: arguments[2], isDirectory: true)
guard let startPage = Int(arguments[3]), let endPage = Int(arguments[4]),
      let scaleValue = Double(arguments[5]), startPage > 0, endPage >= startPage else {
    fail("invalid page range or scale")
}
guard let document = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
    fail("cannot open PDF: \(inputPath)")
}

try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]

for pageNumber in startPage...min(endPage, document.pageCount) {
    autoreleasepool {
        let outputURL = outputDirectory.appendingPathComponent(String(format: "%04d.json", pageNumber))
        if FileManager.default.fileExists(atPath: outputURL.path) { return }
        guard let page = document.page(at: pageNumber - 1),
              let image = render(page: page, scale: CGFloat(scaleValue)) else {
            FileHandle.standardError.write(Data("failed to render page \(pageNumber)\n".utf8))
            return
        }
        do {
            let (text, confidence) = try recognize(image: image)
            let result = PageOCR(
                page: pageNumber,
                characterCount: text.count,
                averageConfidence: confidence,
                text: text
            )
            let data = try encoder.encode(result)
            try data.write(to: outputURL, options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("failed to OCR page \(pageNumber): \(error)\n".utf8))
        }
    }
}
