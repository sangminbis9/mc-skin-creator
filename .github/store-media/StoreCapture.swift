import XCTest

final class StoreCapture: XCTestCase {
    func testCapture() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.sangminbis9.skinstudio")
        app.launch()
        let sample = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "샘플 스킨으로 시작하기", "Start with a sample skin")).firstMatch
        XCTAssertTrue(sample.waitForExistence(timeout: 25))
        sleep(2)
        save("01-photo-to-skin")
        _ = FileManager.default.createFile(atPath: "/tmp/skin-store-recording", contents: Data())
        sleep(5)
        sample.tap()

        let edit = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "스킨 편집", "Edit skin")).firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 20))
        sleep(2)
        save("02-preview")
        let stage = app.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.43))
        stage.press(forDuration: 0.15, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.68, dy: 0.43)))
        sleep(2)
        edit.tap()

        let editor = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label == %@", "스킨 편집", "Edit skin")).firstMatch
        if editor.waitForExistence(timeout: 9) { sleep(1) }
        save("03-editor")
        sleep(4)
        let library = app.links.matching(NSPredicate(format: "label == %@ OR label == %@", "보관함", "Library")).firstMatch
        if library.exists && library.isHittable {
            library.tap()
            sleep(2)
            save("04-library")
        }
        sleep(5)
    }

    private func save(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
