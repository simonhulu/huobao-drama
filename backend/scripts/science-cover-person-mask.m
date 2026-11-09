#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) { fprintf(stderr, "Expected source image and output PNG mask\n"); return 2; }
    NSURL *source = [NSURL fileURLWithPath:@(argv[1])];
    NSURL *output = [NSURL fileURLWithPath:@(argv[2])];
    VNGeneratePersonSegmentationRequest *request = [[VNGeneratePersonSegmentationRequest alloc] init];
    request.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelAccurate;
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:source options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error] || !request.results.firstObject) {
      fprintf(stderr, "Presenter segmentation failed: %s\n", error.localizedDescription.UTF8String ?: "no person"); return 1;
    }
    CIImage *mask = [CIImage imageWithCVPixelBuffer:request.results.firstObject.pixelBuffer];
    CIContext *context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer:@YES}];
    CGImageRef image = [context createCGImage:mask fromRect:mask.extent];
    if (!image) { fprintf(stderr, "Could not encode presenter mask\n"); return 1; }
    NSData *png = [[[NSBitmapImageRep alloc] initWithCGImage:image] representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    CGImageRelease(image);
    if (![png writeToURL:output options:NSDataWritingAtomic error:&error]) {
      fprintf(stderr, "Could not save presenter mask: %s\n", error.localizedDescription.UTF8String); return 1;
    }
    return 0;
  }
}
